/**
 * WindsurfExecutor — routes requests to Windsurf (Devin CLI / Codeium) backend.
 *
 * Wire protocol: gRPC-web over HTTPS (Content-Type: application/grpc-web+proto).
 * Service:       exa.language_server_pb.LanguageServerService
 * Method:        GetChatMessage  (unary → streamed as SSE)
 *
 * Authentication:
 *   credentials.accessToken  = Codeium API key from windsurf.com/show-auth-token
 *   — placed in Metadata.api_key protobuf field of every request.
 *
 * Model IDs accepted by this executor (snake_case sent to Windsurf wire):
 *   Cognition SWE:  swe-1, swe-1-5, swe-1-6, swe-1-6-fast, swe-1-7, swe-1-7-fast, swe-1-lite
 *   Claude:         claude-4-5-sonnet, claude-4-5-opus, claude-4-sonnet, claude-4-opus,
 *                   claude-3-7-sonnet, claude-3-7-sonnet-thinking
 *   Gemini:         gemini-2-5-pro, gemini-2-5-flash, gemini-3-0-pro, gemini-3-0-flash
 *   OpenAI:         gpt-4-1, gpt-4-5, o1, o1-mini
 *
 * OmniRoute → Windsurf model-ID mapping lives in MODEL_ID_MAP below.
 */

import { BaseExecutor, mergeUpstreamExtraHeaders, type ExecuteInput } from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { randomUUID } from "node:crypto";

// ─── Windsurf API constants ──────────────────────────────────────────────────

const WS_BASE_URL = "https://server.codeium.com";
const WS_SERVICE = "exa.api_server_pb.ApiServerService";
const WS_METHOD_CHAT = "GetChatMessage";
const WS_CHAT_URL = `${WS_BASE_URL}/${WS_SERVICE}/${WS_METHOD_CHAT}`;

const WS_IDE_NAME = "windsurf";
const WS_IDE_VERSION = "3.14.0";
const WS_EXT_VERSION = "3.14.0";
const WS_LOCALE = "en-US";

// ─── Model alias normalizer ──────────────────────────────────────────────────
//
// Model names are passed directly to the Windsurf API as ModelOrAlias strings.
// The API accepts the catalog names as-is (e.g. "claude-4.5-sonnet", "swe-1.6-fast").
//
// This table handles only OmniRoute-style backwards-compat aliases where users
// might type dashes instead of dots (e.g. "swe-1-6-fast" → "swe-1.6-fast").

// Model IDs — source: model_configs_v2.bin extracted from Devin CLI binary.
// OmniRoute uses dot-notation user IDs (e.g. "gpt-5.5-high").
// Windsurf API accepts dash-notation modelUids (e.g. "gpt-5-5-high").
// This map normalises dot→dash for newer models and handles legacy aliases.
const MODEL_ALIAS_MAP: Record<string, string> = {
  // ── SWE ─────────────────────────────────────────────────────────────────
  "swe-1.7-fast": "swe-1-7-fast",
  "swe-1.7": "swe-1-7",
  "swe-1.6-fast": "swe-1-6-fast",
  "swe-1.6": "swe-1-6",
  "swe-1.5-fast": "swe-1p5", // fast variant
  "swe-1.5": "swe-1p5",
  // ── Claude Opus 4.8 ──────────────────────────────────────────────────────
  "claude-opus-4.8-max": "claude-opus-4-8-max",
  "claude-opus-4.8-xhigh": "claude-opus-4-8-xhigh",
  "claude-opus-4.8-high": "claude-opus-4-8-high",
  "claude-opus-4.8-medium": "claude-opus-4-8-medium",
  "claude-opus-4.8-low": "claude-opus-4-8-low",
  // ── Claude Opus 4.7 ──────────────────────────────────────────────────────
  "claude-opus-4.7-max": "claude-opus-4-7-max",
  "claude-opus-4.7-xhigh": "claude-opus-4-7-xhigh",
  "claude-opus-4.7-high": "claude-opus-4-7-high",
  "claude-opus-4.7-medium": "claude-opus-4-7-medium",
  "claude-opus-4.7-low": "claude-opus-4-7-low",
  "claude-opus-4.7-review": "opus-4-7-review",
  // ── Claude Opus/Sonnet 4.6 ───────────────────────────────────────────────
  "claude-sonnet-4.6-thinking-1m": "claude-sonnet-4-6-thinking-1m",
  "claude-sonnet-4.6-1m": "claude-sonnet-4-6-1m",
  "claude-sonnet-4.6-thinking": "claude-sonnet-4-6-thinking",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-opus-4.6-thinking": "claude-opus-4-6-thinking",
  "claude-opus-4.6": "claude-opus-4-6",
  // ── Claude 4.5 ───────────────────────────────────────────────────────────
  "claude-opus-4.5-thinking": "MODEL_CLAUDE_4_5_OPUS_THINKING",
  "claude-opus-4.5": "MODEL_CLAUDE_4_5_OPUS",
  "claude-sonnet-4.5-thinking": "MODEL_PRIVATE_3",
  "claude-sonnet-4.5": "MODEL_PRIVATE_2",
  "claude-haiku-4.5": "MODEL_PRIVATE_11",
  // backward-compat flat names
  "claude-4.5-opus-thinking": "MODEL_CLAUDE_4_5_OPUS_THINKING",
  "claude-4.5-opus": "MODEL_CLAUDE_4_5_OPUS",
  "claude-4.5-sonnet-thinking": "MODEL_PRIVATE_3",
  "claude-4.5-sonnet": "MODEL_PRIVATE_2",
  "claude-4.5-haiku": "MODEL_PRIVATE_11",
  // ── GPT-5.5 ──────────────────────────────────────────────────────────────
  "gpt-5.5-xhigh-fast": "gpt-5-5-xhigh-priority",
  "gpt-5.5-high-fast": "gpt-5-5-high-priority",
  "gpt-5.5-medium-fast": "gpt-5-5-medium-priority",
  "gpt-5.5-low-fast": "gpt-5-5-low-priority",
  "gpt-5.5-none-fast": "gpt-5-5-none-priority",
  "gpt-5.5-xhigh": "gpt-5-5-xhigh",
  "gpt-5.5-high": "gpt-5-5-high",
  "gpt-5.5-medium": "gpt-5-5-medium",
  "gpt-5.5-low": "gpt-5-5-low",
  "gpt-5.5-none": "gpt-5-5-none",
  "gpt-5.5-review": "gpt-5-5-review",
  "gpt-5.5": "gpt-5-5-medium", // default effort level
  // ── GPT-5.4 ──────────────────────────────────────────────────────────────
  "gpt-5.4-xhigh-fast": "gpt-5-4-xhigh-priority",
  "gpt-5.4-high-fast": "gpt-5-4-high-priority",
  "gpt-5.4-medium-fast": "gpt-5-4-medium-priority",
  "gpt-5.4-low-fast": "gpt-5-4-low-priority",
  "gpt-5.4-none-fast": "gpt-5-4-none-priority",
  "gpt-5.4-xhigh": "gpt-5-4-xhigh",
  "gpt-5.4-high": "gpt-5-4-high",
  "gpt-5.4-medium": "gpt-5-4-medium",
  "gpt-5.4-low": "gpt-5-4-low",
  "gpt-5.4-none": "gpt-5-4-none",
  "gpt-5.4-mini-xhigh": "gpt-5-4-mini-xhigh",
  "gpt-5.4-mini-high": "gpt-5-4-mini-high",
  "gpt-5.4-mini-medium": "gpt-5-4-mini-medium",
  "gpt-5.4-mini-low": "gpt-5-4-mini-low",
  "gpt-5.4": "gpt-5-4-medium", // default effort level
  // ── GPT-5.3-Codex ────────────────────────────────────────────────────────
  "gpt-5.3-codex-xhigh-fast": "gpt-5-3-codex-xhigh-priority",
  "gpt-5.3-codex-high-fast": "gpt-5-3-codex-high-priority",
  "gpt-5.3-codex-medium-fast": "gpt-5-3-codex-medium-priority",
  "gpt-5.3-codex-low-fast": "gpt-5-3-codex-low-priority",
  "gpt-5.3-codex-xhigh": "gpt-5-3-codex-xhigh",
  "gpt-5.3-codex-high": "gpt-5-3-codex-high",
  "gpt-5.3-codex-medium": "gpt-5-3-codex-medium",
  "gpt-5.3-codex-low": "gpt-5-3-codex-low",
  "gpt-5.3-codex": "gpt-5-3-codex-medium",
  // ── GPT-5.2 ──────────────────────────────────────────────────────────────
  "gpt-5.2-xhigh": "MODEL_GPT_5_2_XHIGH",
  "gpt-5.2-high": "MODEL_GPT_5_2_HIGH",
  "gpt-5.2-medium": "MODEL_GPT_5_2_MEDIUM",
  "gpt-5.2-low": "MODEL_GPT_5_2_LOW",
  "gpt-5.2-none": "MODEL_GPT_5_2_NONE",
  "gpt-5.2": "MODEL_GPT_5_2_MEDIUM",
  // ── GPT-5 ────────────────────────────────────────────────────────────────
  "gpt-5": "gpt-5",
  // ── GPT-4.1 / 4o ─────────────────────────────────────────────────────────
  "gpt-4.1": "MODEL_CHAT_GPT_4_1_2025_04_14",
  "gpt-4.1-mini": "gpt-4.1-mini",
  "gpt-4o": "MODEL_CHAT_GPT_4O_2024_08_06",
  // ── Gemini ────────────────────────────────────────────────────────────────
  "gemini-3.1-pro-high": "gemini-3-1-pro-high",
  "gemini-3.1-pro-low": "gemini-3-1-pro-low",
  "gemini-3.1-pro": "gemini-3-1-pro-high",
  "gemini-3.0-flash-high": "MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH",
  "gemini-3.0-flash-medium": "MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM",
  "gemini-3.0-flash-low": "MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW",
  "gemini-3.0-flash-minimal": "MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL",
  "gemini-3.0-flash": "MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH",
  "gemini-2.5-pro": "MODEL_GOOGLE_GEMINI_2_5_PRO",
  // ── Others ───────────────────────────────────────────────────────────────
  "deepseek-v4": "deepseek-v4",
  "kimi-k2.7": "kimi-k2-7",
  "kimi-k2.6": "kimi-k2-6",
  "kimi-k2.5": "kimi-k2-5",
  "glm-5.2": "glm-5-2",
  "glm-5.2-high": "glm-5-2",
  "glm-5.2-max": "glm-5-2-max",
  "glm-5.2-max-1m": "glm-5-2-max-1m",
  "glm-5.1": "glm-5-1",
};

function resolveWsModelId(model: string): string {
  return MODEL_ALIAS_MAP[model] ?? model;
}

// ─── Minimal protobuf encoder ────────────────────────────────────────────────
//
// Implements only what is needed for GetChatMessageRequest.
// Wire types: 0 = varint, 2 = length-delimited.

export function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}

function concatBytes(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

const TEXT_ENC = new TextEncoder();
const TEXT_DEC = new TextDecoder();

/** Encode a length-delimited field (strings and nested messages share wire type 2). */
function encodeField(fieldNum: number, payload: Uint8Array): Uint8Array {
  const tag = encodeVarint((fieldNum << 3) | 2);
  const len = encodeVarint(payload.length);
  return concatBytes([tag, len, payload]);
}

/** Encode a UTF-8 string field. */
function encodeString(fieldNum: number, value: string): Uint8Array {
  return encodeField(fieldNum, TEXT_ENC.encode(value));
}

/** Encode a nested message field. */
function encodeMessage(fieldNum: number, msg: Uint8Array): Uint8Array {
  return encodeField(fieldNum, msg);
}

/** Encode a varint field (wire type 0) — used for enums and booleans. */
export function encodeVarintField(fieldNum: number, value: number): Uint8Array {
  const tag = encodeVarint((fieldNum << 3) | 0);
  return concatBytes([tag, encodeVarint(value)]);
}

/** Encode a boolean field (wire type 0, varint 0 or 1). */
function encodeBoolField(fieldNum: number, value: boolean): Uint8Array {
  return encodeVarintField(fieldNum, value ? 1 : 0);
}

// ─── Platform detection ──────────────────────────────────────────────────────

function detectOs(): string {
  const p = process.platform;
  if (p === "darwin") return "macos";
  if (p === "win32") return "windows";
  return "linux";
}

function detectHardware(): string {
  return process.arch === "arm64" ? "arm64" : "x86_64";
}

// ─── ChatMessageSource enum (exa.chat_pb.ChatMessageSource) ──────────────────
//
//   0 = UNSPECIFIED
//   1 = USER
//   2 = SYSTEM
//   3 = UNKNOWN   (used for ASSISTANT messages)
//   4 = TOOL
//   5 = SYSTEM_PROMPT

const CHAT_MSG_SRC = {
  USER: 1,
  SYSTEM: 2,
  ASSISTANT: 3,
  TOOL: 4,
} as const;

function roleToSource(role: string): number {
  const r = role.toLowerCase();
  if (r === "user") return CHAT_MSG_SRC.USER;
  if (r === "system") return CHAT_MSG_SRC.SYSTEM;
  if (r === "assistant") return CHAT_MSG_SRC.ASSISTANT;
  if (r === "tool") return CHAT_MSG_SRC.TOOL;
  return CHAT_MSG_SRC.USER;
}

// ─── Protobuf message builders ───────────────────────────────────────────────
//
// Schema extracted from @exa/chat-client (Windsurf IDE extension):
//
// Metadata (exa.codeium_common_pb.Metadata):
//   1: ide_name (string)
//   2: extension_version (string)
//   3: api_key (string)
//   4: locale (string)
//   5: os (string)
//   7: ide_version (string)
//   8: hardware (string)
//   9: request_id (uint64)
//   10: session_id (string)
//   12: extension_name (string)
//   21: user_jwt (string)
//
// GetChatMessageRequest (exa.api_server_pb.GetChatMessageRequest):
//   1: metadata (message)
//   2: prompt (string) — latest user prompt
//   3: chat_message_prompts (repeated ChatMessagePrompt) — conversation history
//   16: cascade_id (string)
//   21: chat_model_uid (string) — model ID like "swe-1-6"
//
// ChatMessagePrompt (exa.chat_pb.ChatMessagePrompt):
//   1: message_id (string)
//   2: source (enum ChatMessageSource)
//   3: prompt (string) — text content
//   7: tool_call_id (string)

function buildMetadata(apiKey: string, sessionId: string): Uint8Array {
  const parts: Uint8Array[] = [
    encodeString(1, WS_IDE_NAME), // ide_name
    encodeString(2, WS_EXT_VERSION), // extension_version
    encodeString(3, apiKey), // api_key (full token with prefix)
    encodeString(4, WS_LOCALE), // locale
    encodeString(5, detectOs()), // os
    encodeString(7, WS_IDE_VERSION), // ide_version
    encodeString(10, sessionId), // session_id
    encodeString(12, "chisel"), // extension_name (Devin CLI uses "chisel")
    encodeString(28, "chisel"), // ide_type
  ];
  // Only set user_jwt (field 21) when the token is a JWT (starts with "eyJ"),
  // not for session tokens (starts with "devin-session-token$") or API keys.
  if (apiKey.startsWith("eyJ")) {
    parts.push(encodeString(21, apiKey)); // user_jwt
  }
  return concatBytes(parts);
}

type WsToolCall = { id: string; name: string; argumentsJson: string };
type WsChatMessage = {
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls?: WsToolCall[];
};

// ChatToolCall { string id = 1; string name = 2; string arguments_json = 3; }
function buildChatToolCall(tc: WsToolCall): Uint8Array {
  return concatBytes([
    encodeString(1, tc.id), // id
    encodeString(2, tc.name), // name
    encodeString(3, tc.argumentsJson), // arguments_json
  ]);
}

function buildChatMessagePrompt(msg: WsChatMessage): Uint8Array {
  const parts: Uint8Array[] = [
    encodeString(1, randomUUID()), // message_id
    encodeVarintField(2, roleToSource(msg.role)), // source enum
    encodeString(3, msg.content), // prompt (text content)
  ];
  // field 6: repeated ChatToolCall tool_calls (assistant messages with tool calls)
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      parts.push(encodeMessage(6, buildChatToolCall(tc)));
    }
  }
  if (msg.toolCallId) {
    parts.push(encodeString(7, msg.toolCallId)); // tool_call_id
  }
  return concatBytes(parts);
}

// ChatToolDefinition { string name = 1; string description = 2; string json_schema_string = 3; bool strict = 4; }
type WsToolDefinition = {
  name: string;
  description: string;
  jsonSchemaString: string;
  strict?: boolean;
};

function buildChatToolDefinition(tool: WsToolDefinition): Uint8Array {
  const parts: Uint8Array[] = [
    encodeString(1, tool.name), // name
    encodeString(2, tool.description), // description
    encodeString(3, tool.jsonSchemaString), // json_schema_string
  ];
  if (tool.strict) {
    parts.push(encodeVarintField(4, 1)); // strict (bool, varint)
  }
  return concatBytes(parts);
}

// ChatToolChoice { string option_name = 1; string tool_name = 2; }
// option_name: "auto" | "none" — "any" is rejected by swe-1.7+ with invalid_argument,
// so openaiToolChoiceToWs maps "any"/"required" → "auto" instead.
type WsToolChoice = { optionName?: string; toolName?: string };

function buildChatToolChoice(choice: WsToolChoice): Uint8Array {
  const parts: Uint8Array[] = [];
  if (choice.optionName) {
    parts.push(encodeString(1, choice.optionName)); // option_name: "auto" | "none"
  }
  if (choice.toolName) {
    parts.push(encodeString(2, choice.toolName)); // tool_name (specific tool)
  }
  return concatBytes(parts);
}

export function buildGetChatMessageRequest(
  apiKey: string,
  model: string,
  messages: WsChatMessage[],
  tools?: WsToolDefinition[],
  toolChoice?: WsToolChoice,
  maxTokens?: number
): Uint8Array {
  const sessionId = randomUUID();
  const cascadeId = randomUUID();

  // Extract the latest user message as the prompt (field 2).
  // All messages (including the latest) go into chat_message_prompts (field 3).
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const prompt = lastUserMsg?.content ?? "";

  const parts: Uint8Array[] = [
    encodeMessage(1, buildMetadata(apiKey, sessionId)), // metadata
    encodeString(2, prompt), // prompt
  ];

  for (const msg of messages) {
    parts.push(encodeMessage(3, buildChatMessagePrompt(msg))); // chat_message_prompts
  }

  // field 4: max_tokens (uint32) — forward client's max_tokens so the model
  // has enough budget to complete tool call JSON after reasoning. Without this,
  // Windsurf defaults to 1024 output tokens, truncating tool call arguments
  // mid-JSON (missing closing `}`), causing InputValidationError in Claude Code.
  if (maxTokens && maxTokens > 0) {
    parts.push(encodeVarintField(4, maxTokens));
  }

  // field 10: repeated ChatToolDefinition tools — native tool definitions
  if (tools && tools.length > 0) {
    for (const tool of tools) {
      parts.push(encodeMessage(10, buildChatToolDefinition(tool)));
    }
  }

  // field 12: ChatToolChoice tool_choice
  if (toolChoice && (toolChoice.optionName || toolChoice.toolName)) {
    parts.push(encodeMessage(12, buildChatToolChoice(toolChoice)));
  }

  // request_type = CASCADE (5) — required for chat completions via the API server.
  parts.push(encodeVarintField(7, 5));
  // provider_source = CHAT (2)
  parts.push(encodeVarintField(18, 2));
  // cascade_id — a UUID for this conversation turn
  parts.push(encodeString(16, cascadeId));
  // chat_model_uid — the resolved Windsurf model identifier
  parts.push(encodeString(21, model));

  return concatBytes(parts);
}

// ─── gRPC-web framing ────────────────────────────────────────────────────────

/** Wrap a protobuf message in a 5-byte gRPC-web data frame. */
function grpcWebFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0x00; // compression flag: no compression
  const view = new DataView(frame.buffer);
  view.setUint32(1, payload.length, false); // big-endian length
  frame.set(payload, 5);
  return frame;
}

// ─── Protobuf response decoder ───────────────────────────────────────────────
//
// GetChatMessageResponse (exa.api_server_pb.GetChatMessageResponse):
//   field 1  (string)  → message_id
//   field 2  (message) → timestamp
//   field 3  (string)  → delta_text      (content text delta)
//   field 4  (uint32)  → delta_tokens
//   field 5  (enum)    → stop_reason      (0=UNSPECIFIED, 2=STOP_PATTERN, 3=MAX_TOKENS, 10=FUNCTION_CALL, 13=ERROR)
//   field 6  (message) → delta_tool_calls (repeated ChatToolCall)
//   field 7  (message) → usage (ModelUsageStats)
//   field 9  (string)  → delta_thinking
//   field 13 (message) → completion_profile
//   field 15 (string)  → output_id
//
// ChatToolCall { string id = 1; string name = 2; string arguments_json = 3; }
//
// ModelUsageStats (exa.codeium_common_pb.ModelUsageStats):
//   field 2 (uint64) → input_tokens
//   field 3 (uint64) → output_tokens

type DecodedToolCall = { id: string; name: string; argumentsJson: string };

type DecodedResponse = {
  deltaText: string;
  deltaThinking: string;
  deltaToolCalls: DecodedToolCall[];
  stopReason: number;
  inputTokens: number;
  outputTokens: number;
};

/** Read a varint from buf starting at offset; returns [value, newOffset]. */
function readVarint(buf: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (offset < buf.length) {
    const b = buf[offset++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result >>> 0, offset];
}

/** Decode a GetChatMessageResponse protobuf payload. */
function decodeGetChatMessageResponse(buf: Uint8Array): DecodedResponse {
  let offset = 0;
  let deltaText = "";
  let deltaThinking = "";
  const deltaToolCalls: DecodedToolCall[] = [];
  let stopReason = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  while (offset < buf.length) {
    let tag: number;
    [tag, offset] = readVarint(buf, offset);
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === 2) {
      // length-delimited
      let len: number;
      [len, offset] = readVarint(buf, offset);
      const payload = buf.slice(offset, offset + len);
      offset += len;

      if (fieldNum === 3) {
        // delta_text (string)
        deltaText = TEXT_DEC.decode(payload);
      } else if (fieldNum === 6) {
        // delta_tool_calls (repeated ChatToolCall) — parse nested message
        const tc = decodeChatToolCall(payload);
        if (tc) deltaToolCalls.push(tc);
      } else if (fieldNum === 7) {
        // usage (ModelUsageStats) — extract input_tokens (field 2) and output_tokens (field 3)
        let uoff = 0;
        while (uoff < payload.length) {
          let utag: number;
          [utag, uoff] = readVarint(payload, uoff);
          const ufn = utag >>> 3;
          const uwt = utag & 0x07;
          if (uwt === 0) {
            let uv: number;
            [uv, uoff] = readVarint(payload, uoff);
            if (ufn === 2) inputTokens = uv;
            else if (ufn === 3) outputTokens = uv;
          } else if (uwt === 2) {
            let ulen: number;
            [ulen, uoff] = readVarint(payload, uoff);
            uoff += ulen;
          } else if (uwt === 1) {
            uoff += 8;
          } else if (uwt === 5) {
            uoff += 4;
          } else {
            break;
          }
        }
      } else if (fieldNum === 9) {
        // delta_thinking (string) — GLM models stream text content here
        deltaThinking = TEXT_DEC.decode(payload);
      }
      // other length-delimited fields are skipped
    } else if (wireType === 0) {
      // varint
      let v: number;
      [v, offset] = readVarint(buf, offset);
      if (fieldNum === 5) stopReason = v; // stop_reason enum
    } else if (wireType === 1) {
      offset += 8; // 64-bit
    } else if (wireType === 5) {
      offset += 4; // 32-bit
    } else {
      break; // unknown wire type — stop parsing
    }
  }

  return { deltaText, deltaThinking, deltaToolCalls, stopReason, inputTokens, outputTokens };
}

/** Decode a ChatToolCall protobuf payload: { string id = 1; string name = 2; string arguments_json = 3; }
 *  Returns partial tool calls (e.g. arguments-only frames) — does NOT require name. */
function decodeChatToolCall(buf: Uint8Array): DecodedToolCall | null {
  let off = 0;
  let id = "";
  let name = "";
  let argumentsJson = "";
  while (off < buf.length) {
    let tag: number;
    [tag, off] = readVarint(buf, off);
    const fn = tag >>> 3;
    const wt = tag & 0x07;
    if (wt === 2) {
      let len: number;
      [len, off] = readVarint(buf, off);
      const val = TEXT_DEC.decode(buf.slice(off, off + len));
      off += len;
      if (fn === 1) id = val;
      else if (fn === 2) name = val;
      else if (fn === 3) argumentsJson = val;
    } else if (wt === 0) {
      let v: number;
      [v, off] = readVarint(buf, off);
    } else if (wt === 1) {
      off += 8;
    } else if (wt === 5) {
      off += 4;
    } else {
      break;
    }
  }
  // Return partial tool call even without name — it may be an arguments-only
  // streaming frame. The caller will merge it into the most recent tool call.
  if (!id && !name && !argumentsJson) return null;
  return { id, name, argumentsJson };
}

// ─── Convert OpenAI messages → Windsurf WsChatMessage[] ──────────────────────

type OpenAIToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type OpenAIMessage = {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
};

function openAIMessagesToWs(messages: OpenAIMessage[]): WsChatMessage[] {
  const out: WsChatMessage[] = [];
  for (const m of messages) {
    // Windsurf upstream rejects messages with role "system" (encoded as
    // CHAT_MSG_SRC.UNKNOWN) with a 502. Convert them to "user" so the
    // content is preserved and the upstream accepts the request.
    // Likewise, "assistant" (CHAT_MSG_SRC.ASSISTANT=3) is rejected — the
    // ApiServer only accepts USER=1 in chat_message_prompts. Convert
    // assistant → user to preserve conversation context without 502.
    const rawRole = String(m.role || "user");
    const role = rawRole === "system" || rawRole === "assistant" ? "user" : rawRole;
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      // Multi-part: concatenate text parts
      for (const part of m.content) {
        if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
          content += String((part as Record<string, unknown>).text || "");
        }
      }
    }
    // Convert OpenAI tool_calls → Windsurf ChatToolCall (field 6 in ChatMessagePrompt)
    let toolCalls: WsToolCall[] | undefined;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      toolCalls = m.tool_calls.map((tc) => ({
        id: tc.id || `call-${randomUUID()}`,
        name: tc.function?.name || "",
        argumentsJson: tc.function?.arguments || "{}",
      }));
    }
    out.push({ role, content, toolCallId: m.tool_call_id, toolCalls });
  }
  return out;
}

// ─── Convert OpenAI tools → Windsurf ChatToolDefinition[] ────────────────────

type OpenAITool = {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
  };
};

// Windsurf's GetChatMessage API rejects tool payloads larger than ~57KB with a
// 502 "internal error". Claude Code with MCP servers can send 300+ tools (~150KB).
// To fit as many tools as possible under the limit we use progressive stripping:
//   Tier 1 (budget > 30KB): full sanitized schema + 200-char description
//   Tier 2 (budget > 10KB): stripped schema {"type":"object"} + 120-char description
//   Tier 3 (budget > 2KB):  name only, no schema, 60-char description
//   Beyond:                 tools are dropped (logged as warning)
// This preserves tool discoverability (model knows the tool exists) even when
// full parameter structure can't be sent. The model can still call the tool with
// best-guess arguments, which is far better than not knowing the tool exists.
const WS_MAX_TOOL_DESC_LEN = 200;
const WS_TOOLS_SIZE_BUDGET = 52000; // under the ~57KB hard limit
const WS_TIER2_THRESHOLD = 30000; // switch to stripped schema when remaining budget drops below this
const WS_TIER3_THRESHOLD = 10000; // switch to name-only when remaining budget drops below this
const WS_TIER2_DESC_LEN = 120;
const WS_TIER3_DESC_LEN = 60;

/** Recursively strip non-essential JSON Schema fields to reduce payload size. */
function sanitizeJsonSchema(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(sanitizeJsonSchema);
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Keep structural fields + validation constraints that affect tool correctness.
  // Dropping additionalProperties/minimum/maximum/pattern/etc. causes the model
  // to hallucinate extra fields or generate out-of-range values the tool rejects.
  // These fields are small (booleans, numbers, short strings) so the size impact
  // is minimal compared to descriptions and nested properties.
  const KEEP = new Set([
    "type",
    "properties",
    "required",
    "enum",
    "items",
    "anyOf",
    "oneOf",
    "allOf",
    "const",
    "description",
    // Validation constraints — prevent invalid tool arguments
    "additionalProperties",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minItems",
    "maxItems",
    "uniqueItems",
    "multipleOf",
  ]);
  for (const [k, v] of Object.entries(obj)) {
    if (!KEEP.has(k)) continue; // skip $schema, default, title, $ref, examples, etc.
    if (k === "description") {
      // Keep top-level property descriptions but truncate
      const s = typeof v === "string" ? v : String(v);
      out[k] = s.length > 80 ? s.slice(0, 80) + "…" : s;
    } else if (k === "properties") {
      // IMPORTANT: The keys of "properties" are arbitrary property names
      // (e.g. "expression", "file_path"). We must NOT filter them through KEEP.
      // Instead, recursively sanitize each property's value (its schema).
      // Guard against malformed schemas where properties is null/non-object.
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const props: Record<string, unknown> = {};
        for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
          props[pk] = sanitizeJsonSchema(pv);
        }
        out[k] = props;
      }
    } else {
      out[k] = sanitizeJsonSchema(v);
    }
  }
  return out;
}

function openaiToolsToWs(tools: unknown): WsToolDefinition[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: WsToolDefinition[] = [];
  const keptNames = new Set<string>();
  let totalSize = 0;
  let tier1Count = 0,
    tier2Count = 0,
    tier3Count = 0;
  // Prioritize tools by schema criticality:
  //   1. Critical builtins (Write, Edit, Read, Bash...) — model uses these most
  //      and MUST see exact params to avoid guessing wrong field names.
  //   2. MCP tools (mcp__*) — model doesn't inherently know their params.
  //   3. Non-critical builtins (Agent, Task, etc.) — model can tolerate stripped
  //      schemas in tier 2/3 since they're used less frequently.
  // Without this, GLM-5.2 confuses Write params with Edit params (e.g. sends
  // `new_string`/`old_string` to Write instead of `content`, or `relative_path`
  // instead of `file_path`) because the schema was stripped to {"type":"object"}.
  const WS_CRITICAL_BUILTINS = new Set([
    "Write",
    "Edit",
    "MultiEdit",
    "Read",
    "Bash",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
    "TodoWrite",
    "NotebookEdit",
    "LS",
  ]);
  const allTools = tools as OpenAITool[];
  const criticalBuiltinTools = allTools.filter(
    (t) => t?.function?.name && WS_CRITICAL_BUILTINS.has(t.function.name)
  );
  const mcpTools = allTools.filter(
    (t) => t?.function?.name?.startsWith("mcp__") && !WS_CRITICAL_BUILTINS.has(t.function.name)
  );
  const otherBuiltinTools = allTools.filter(
    (t) =>
      t?.function?.name &&
      !t.function.name.startsWith("mcp__") &&
      !WS_CRITICAL_BUILTINS.has(t.function.name)
  );
  const orderedTools = [...criticalBuiltinTools, ...mcpTools, ...otherBuiltinTools];
  for (const t of orderedTools) {
    if (!t?.function?.name) continue;
    const name = t.function.name;
    const rawDesc = typeof t.function.description === "string" ? t.function.description : "";

    // Progressive stripping based on remaining budget
    const remaining = WS_TOOLS_SIZE_BUDGET - totalSize;
    let desc: string;
    let schemaStr: string;

    if (remaining > WS_TIER2_THRESHOLD) {
      // Tier 1: full sanitized schema + full description
      tier1Count++;
      desc =
        rawDesc.length > WS_MAX_TOOL_DESC_LEN
          ? rawDesc.slice(0, WS_MAX_TOOL_DESC_LEN) + "…"
          : rawDesc;
      try {
        const sanitized = sanitizeJsonSchema(t.function.parameters);
        schemaStr = t.function.parameters ? JSON.stringify(sanitized) : "{}";
      } catch {
        schemaStr = "{}";
      }
    } else if (remaining > WS_TIER3_THRESHOLD) {
      // Tier 2: stripped schema (type only) + shorter description
      tier2Count++;
      desc =
        rawDesc.length > WS_TIER2_DESC_LEN ? rawDesc.slice(0, WS_TIER2_DESC_LEN) + "…" : rawDesc;
      schemaStr = '{"type":"object"}';
    } else {
      // Tier 3: name only, minimal schema, very short description
      tier3Count++;
      desc =
        rawDesc.length > WS_TIER3_DESC_LEN ? rawDesc.slice(0, WS_TIER3_DESC_LEN) + "…" : rawDesc;
      schemaStr = "{}";
    }

    const entrySize = desc.length + schemaStr.length + name.length;
    if (totalSize + entrySize > WS_TOOLS_SIZE_BUDGET) {
      // Budget exhausted — log dropped tools and stop
      const droppedNames = orderedTools
        .slice(out.length)
        .map((tt) => tt?.function?.name)
        .filter(Boolean) as string[];
      if (droppedNames.length > 0) {
        console.warn(
          `[WINDSURF_TOOLS] Dropped ${droppedNames.length} tools (budget exhausted at ${totalSize}/${WS_TOOLS_SIZE_BUDGET}). ` +
            `Kept ${out.length}/${allTools.length} (tier1=${tier1Count}, tier2=${tier2Count}, tier3=${tier3Count}). ` +
            `Dropped (first 10): ${droppedNames.slice(0, 10).join(", ")}`
        );
      }
      break;
    }
    totalSize += entrySize;
    keptNames.add(name);
    out.push({ name, description: desc, jsonSchemaString: schemaStr });
  }
  return out.length > 0 ? out : undefined;
}

// ─── Convert OpenAI tool_choice → Windsurf ChatToolChoice ───────────────────

function openaiToolChoiceToWs(toolChoice: unknown): WsToolChoice | undefined {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") {
    // "auto" | "none" | "required"
    if (toolChoice === "auto") return { optionName: "auto" };
    if (toolChoice === "none") return { optionName: "none" };
    // "required" → "auto": Windsurf's "any" option triggers invalid_argument
    // on newer models (swe-1.7+). "auto" still permits tool calls, just doesn't
    // force them — safer than a hard rejection.
    if (toolChoice === "required") return { optionName: "auto" };
    return undefined;
  }
  if (typeof toolChoice === "object") {
    const tc = toolChoice as Record<string, unknown>;
    const fn = tc.function as Record<string, unknown> | undefined;
    if (fn?.name) return { toolName: String(fn.name) };
    if (tc.type === "auto") return { optionName: "auto" };
    if (tc.type === "none") return { optionName: "none" };
    // "any"/"required" → "auto": see comment above re: swe-1.7 invalid_argument.
    if (tc.type === "any" || tc.type === "required") return { optionName: "auto" };
  }
  return undefined;
}

// ─── WindsurfExecutor ─────────────────────────────────────────────────────────

export class WindsurfExecutor extends BaseExecutor {
  constructor() {
    super("windsurf", PROVIDERS["windsurf"] || { id: "windsurf", baseUrl: WS_CHAT_URL });
  }

  buildUrl(): string {
    return WS_CHAT_URL;
  }

  buildHeaders(credentials: { accessToken?: string; apiKey?: string }): Record<string, string> {
    const rawToken = credentials.accessToken || credentials.apiKey || "";
    // The Devin CLI uses Basic auth with the token repeated as username:password
    // (separated by "-"). The full token including "devin-session-token$" prefix is sent.
    // For API keys (sk-...), use Bearer auth instead.
    const isSessionToken = rawToken.startsWith("devin-session-token$");
    const authHeader = isSessionToken
      ? { Authorization: `Basic ${rawToken}-${rawToken}` }
      : rawToken
        ? { Authorization: `Bearer ${rawToken}` }
        : {};
    return {
      // Connect streaming uses application/connect+proto; unary uses application/proto.
      // GetChatMessage is a server-streaming RPC.
      "Content-Type": "application/connect+proto",
      Accept: "application/connect+proto",
      // Connect protocol version header (Buf Connect-RPC).
      "connect-protocol-version": "1",
      ...authHeader,
      "User-Agent": `windsurf/${WS_IDE_VERSION}`,
    };
  }

  transformRequest(): unknown {
    // Request body is built manually in execute() because it requires the model + messages
    return null;
  }

  async execute({
    model,
    body,
    stream,
    credentials,
    signal,
    log,
    upstreamExtraHeaders,
  }: ExecuteInput): Promise<{
    response: Response;
    url: string;
    headers: Record<string, string>;
    transformedBody: unknown;
  }> {
    const rawToken = credentials.accessToken || credentials.apiKey || "";
    // Do NOT strip the "devin-session-token$" prefix — the server expects the full
    // token string in Metadata.api_key, and the prefix is part of the credential.
    const apiKey = rawToken;
    const wsModel = resolveWsModelId(model);

    // Parse OpenAI messages from request body
    const b = (body ?? {}) as Record<string, unknown>;
    const rawMessages = Array.isArray(b.messages) ? (b.messages as OpenAIMessage[]) : [];

    // Native tool support: Windsurf's GetChatMessageRequest accepts tool
    // definitions (field 10), tool_choice (field 12), and tool_calls in
    // ChatMessagePrompt (field 6). Convert OpenAI tools/tool_choice to the
    // Windsurf protobuf format so models like GLM-5.2 can emit native tool_calls.
    const wsTools = openaiToolsToWs(b.tools);
    let wsToolChoice = openaiToolChoiceToWs(b.tool_choice);
    const hasTools = wsTools !== undefined && wsTools.length > 0;

    // Cross-validate toolChoice: if a specific tool is forced but was dropped
    // by the budget, clear the toolChoice to avoid Windsurf 400/502 for a
    // non-existent tool definition.
    if (wsToolChoice?.toolName && wsTools) {
      const keptToolNames = new Set(wsTools.map((t) => t.name));
      if (!keptToolNames.has(wsToolChoice.toolName)) {
        console.warn(
          `[WINDSURF_TOOLS] toolChoice "${wsToolChoice.toolName}" was dropped by budget — clearing toolChoice to avoid upstream error`
        );
        wsToolChoice = undefined;
      }
    }

    const wsMessages = openAIMessagesToWs(rawMessages);

    if (wsMessages.length === 0) {
      wsMessages.push({ role: "user", content: "" });
    }

    // Build the protobuf request and frame it for Connect streaming protocol.
    // Connect streaming framing: 1 byte flags (0=no compression) + 4 bytes BE length + payload.
    const protoPayload = buildGetChatMessageRequest(
      apiKey,
      wsModel,
      wsMessages,
      wsTools,
      wsToolChoice,
      typeof b.max_tokens === "number" ? b.max_tokens : undefined
    );
    const framedPayload = grpcWebFrame(protoPayload); // same format as gRPC-web data frame

    const url = this.buildUrl();
    const headers = this.buildHeaders(credentials);
    mergeUpstreamExtraHeaders(headers, upstreamExtraHeaders);

    log?.info?.(
      "WS",
      `Windsurf → ${wsModel} (${wsMessages.length} messages${hasTools ? `, ${wsTools!.length} tools native` : ""})`
    );

    const upstream = await fetch(url, {
      method: "POST",
      headers,
      body: framedPayload,
      signal: signal ?? undefined,
    });

    if (!upstream.ok && upstream.status !== 200) {
      return { response: upstream, url, headers, transformedBody: protoPayload };
    }

    // Transform Connect binary response → SSE stream.
    // Native tool_calls (delta_tool_calls field 6) are parsed from the
    // protobuf response and emitted as OpenAI tool_calls deltas.
    const sseResponse = this.transformToSSE(upstream, model, stream, hasTools);
    return { response: sseResponse, url, headers, transformedBody: protoPayload };
  }

  /** Convert a Connect streaming response body into an OpenAI-compatible SSE stream.
   *
   *  Connect streaming framing: 1 byte flags + 4 bytes BE length + payload
   *    flags bit 0 (0x01): end of stream
   *    flags bit 1 (0x02): trailer frame (payload = key:value\n pairs)
   *  Data frames contain a GetChatMessageResponse protobuf message.
   */
  private transformToSSE(
    upstream: Response,
    model: string,
    _stream: boolean,
    hasTools: boolean
  ): Response {
    // hasTools: when false, skip tool-call field parsing entirely to avoid
    // false-positive tool call emissions from unrelated protobuf fields.
    const responseId = `chatcmpl-ws-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    const sseStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        let roleEmitted = false;
        let totalText = "";
        let hasReasoning = false;
        let promptTokens = 0;
        let completionTokens = 0;
        let hadError: string | null = null;
        let sawToolCalls = false;
        // Track tool calls by stable key (id or name) → { index, started }.
        // Windsurf streams tool call arguments across multiple delta_tool_calls
        // frames. Each frame for the SAME tool call must use the SAME OpenAI
        // `index` so downstream translators (openai-to-claude) accumulate
        // arguments into a single content_block instead of creating a new
        // content_block_start per frame (which produced input:{} + InputValidationError).
        // Additionally, Windsurf sends arguments-only frames (ChatToolCall with
        // only field 3, no id or name) — these must be merged into the most
        // recent tool call.
        const toolCallMap = new Map<
          string,
          { index: number; started: boolean; hasId: boolean; name: string }
        >();
        let nextToolCallIndex = 0;
        let lastToolCallKey: string | null = null; // fallback for arguments-only frames
        // Map protobuf array position → tool call key. Windsurf's delta_tool_calls
        // is a repeated field — the array position within each frame implicitly
        // identifies which tool call a delta belongs to. This lets us route
        // arguments-only frames (no id, no name) to the correct tool call even
        // when multiple tool calls are streamed in parallel.
        const toolCallKeysByPos = new Map<number, string>();

        function emit(data: string) {
          controller.enqueue(enc.encode(data));
        }

        function ensureRole() {
          if (!roleEmitted) {
            emit(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
                ],
              })}\n\n`
            );
            roleEmitted = true;
          }
        }

        try {
          let pending = new Uint8Array(0);
          const reader = upstream.body?.getReader();

          const handleFrame = (flags: number, payload: Uint8Array) => {
            // Connect trailer frame (flags bit 1 set)
            if (flags & 0x02) {
              const trailer = TEXT_DEC.decode(payload);
              // Connect trailers are key:value pairs separated by newlines.
              // Look for error indicators: connect-protocol-error or grpc-status.
              const errMatch = /connect-protocol-error:\s*(.+)/i.exec(trailer);
              if (errMatch) {
                hadError = errMatch[1].trim();
                return;
              }
              const statusMatch = /grpc-status:\s*(\d+)/i.exec(trailer);
              if (statusMatch && statusMatch[1] !== "0") {
                const msgMatch = /grpc-message:\s*(.+)/i.exec(trailer);
                hadError = msgMatch
                  ? decodeURIComponent(msgMatch[1].trim())
                  : `gRPC status ${statusMatch[1]}`;
                return;
              }
              // Some Windsurf error responses are raw JSON in the trailer frame.
              try {
                const j = JSON.parse(trailer);
                if (j?.error?.message) {
                  // Include the gRPC/Connect error code (e.g. "resource_exhausted")
                  // in the error string so the downstream error classifier can
                  // match it against CREDITS_EXHAUSTED_SIGNALS. Without the code,
                  // "an internal error occurred" from a resource_exhausted response
                  // is classified as SERVER_ERROR instead of QUOTA_EXHAUSTED.
                  const code = j.error.code ? `[${j.error.code}] ` : "";
                  hadError = code + j.error.message;
                  return;
                }
              } catch {
                // not JSON, ignore
              }
              // Windsurf sometimes puts the error in a "message" field directly.
              // Use specific patterns to avoid false-positive "hadError" from
              // benign messages containing the word "error" (e.g. "no error occurred").
              const msgField = /message:\s*(.+)/i.exec(trailer);
              if (
                msgField &&
                /rate limit|internal error|invalid_request|unauthorized|forbidden|content policy|safety filter/i.test(
                  msgField[1]
                )
              ) {
                hadError = msgField[1].trim();
                return;
              }
              return;
            }

            // Data frame — decode as GetChatMessageResponse
            const resp = decodeGetChatMessageResponse(payload);

            if (resp.deltaText) {
              totalText += resp.deltaText;
              ensureRole();
              emit(
                `data: ${JSON.stringify({
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: resp.deltaText }, finish_reason: null }],
                })}\n\n`
              );
            }

            // GLM-5.x models stream thinking/reasoning via field 9 (delta_thinking)
            // and actual content via field 3 (delta_text). Emit field 9 as
            // reasoning_content so downstream translators (openai-to-claude) create
            // proper thinking blocks instead of merging thinking into text.
            // Gate to GLM models only — other models use field 9 for internal
            // reasoning tokens that should not leak into user-visible content.
            const isGlmModel = /glm/i.test(model);
            if (isGlmModel && resp.deltaThinking) {
              hasReasoning = true;
              ensureRole();
              emit(
                `data: ${JSON.stringify({
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { reasoning_content: resp.deltaThinking },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`
              );
            }

            // Native tool calls: delta_tool_calls (field 6, repeated ChatToolCall)
            // Windsurf streams tool call arguments across multiple frames. We
            // must use a STABLE index per tool call (keyed by id or name) so
            // that downstream translators accumulate arguments into one block.
            // First frame for a tool call: emit id + name + initial args.
            // Subsequent frames: emit same index, only the argument fragment
            // (no id/name) so the translator appends to the existing block.
            if (hasTools && resp.deltaToolCalls && resp.deltaToolCalls.length > 0) {
              sawToolCalls = true;
              ensureRole();
              for (let pos = 0; pos < resp.deltaToolCalls.length; pos++) {
                const tc = resp.deltaToolCalls[pos];
                // Determine if this is a new tool call, a continuation, or
                // an arguments-only partial frame (no id or name).
                let key: string;
                if (tc.id) {
                  key = tc.id;
                } else if (tc.name) {
                  // If a tool call with this name already exists AND had no id,
                  // this could be a second call to the same tool — create a
                  // new entry to avoid merging two distinct tool calls.
                  const existing = toolCallMap.get(tc.name);
                  if (existing && !existing.hasId) {
                    // Second call to same tool without ids — new entry
                    key = `${tc.name}#${nextToolCallIndex}`;
                  } else {
                    key = tc.name;
                  }
                } else {
                  // Arguments-only frame (no id, no name).
                  // Try array position first — this correctly routes parallel
                  // tool call arguments to the right tool call.
                  const posKey = toolCallKeysByPos.get(pos);
                  if (posKey) {
                    key = posKey;
                  } else if (lastToolCallKey) {
                    // Fallback: merge into the most recent tool call.
                    // This is correct for sequential streaming (one tool call
                    // at a time) but may misroute with parallel tool calls.
                    key = lastToolCallKey;
                  } else {
                    // No prior tool call — skip orphan arguments frame
                    continue;
                  }
                }

                let entry = toolCallMap.get(key);
                if (!entry) {
                  entry = { index: nextToolCallIndex++, started: false, hasId: false, name: "" };
                  toolCallMap.set(key, entry);
                }
                // Track whether this tool call has a real id (for dedup logic)
                if (tc.id) entry.hasId = true;
                // Accumulate name across frames — emit when first non-empty
                if (tc.name && !entry.name) entry.name = tc.name;
                // Map this array position → key so future arguments-only frames
                // at the same position route to the correct tool call.
                toolCallKeysByPos.set(pos, key);
                lastToolCallKey = key;

                const isFirst = !entry.started;
                // Only mark started when we have a name (or this is a continuation
                // of a named tool call). Defer emission if name is still empty
                // so we don't emit name: "" permanently.
                if (isFirst && !entry.name && !tc.argumentsJson) {
                  // First frame with only an id, no name yet — buffer and wait
                  continue;
                }
                // Defer emission when first frame has name but NO arguments.
                // GLM-5.2-max sometimes emits a phantom tool call header (id + name)
                // with empty arguments, then never sends args for it. If we emit
                // content_block_start with input:{}, the downstream shim can't
                // populate it, causing InputValidationError. By deferring, we only
                // emit when args actually arrive (or skip entirely if they don't).
                if (isFirst && entry.name && !tc.argumentsJson) {
                  // Have name but no args yet — buffer and wait for args
                  continue;
                }
                entry.started = true;

                const toolCallDelta: Record<string, unknown> = {
                  index: entry.index,
                  type: "function",
                };

                if (isFirst) {
                  // First emitted frame: include id + name so the translator creates
                  // a single content_block_start for this tool call.
                  toolCallDelta.id = tc.id || `call-${Date.now()}-${entry.index}`;
                  toolCallDelta.function = {
                    name: entry.name || tc.name || "",
                    arguments: tc.argumentsJson || "",
                  };
                } else if (tc.name && !isFirst) {
                  // Name arrived in a later frame — emit it as a correction.
                  // The translator will update the tool call name.
                  toolCallDelta.id = tc.id || toolCallDelta.id;
                  toolCallDelta.function = {
                    name: tc.name,
                    arguments: tc.argumentsJson || "",
                  };
                } else {
                  // Subsequent frame: only send argument fragment. No id/name
                  // so the translator accumulates into the existing block.
                  toolCallDelta.function = {
                    arguments: tc.argumentsJson || "",
                  };
                }

                emit(
                  `data: ${JSON.stringify({
                    id: responseId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: { tool_calls: [toolCallDelta] },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`
                );
              }
            }

            if (resp.inputTokens > 0) promptTokens = resp.inputTokens;
            if (resp.outputTokens > 0) completionTokens = resp.outputTokens;

            // stop_reason 13 = STOP_REASON_ERROR
            if (resp.stopReason === 13) {
              hadError = "Windsurf returned STOP_REASON_ERROR";
            }
          };

          const drainFrames = () => {
            let offset = 0;
            while (offset + 5 <= pending.length) {
              const flags = pending[offset];
              const len =
                (pending[offset + 1] << 24) |
                (pending[offset + 2] << 16) |
                (pending[offset + 3] << 8) |
                pending[offset + 4];
              if (len < 0 || offset + 5 + len > pending.length) break;
              handleFrame(flags, pending.slice(offset + 5, offset + 5 + len));
              offset += 5 + len;
            }
            if (offset > 0) pending = pending.slice(offset);
          };

          if (reader) {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value) continue;
                pending = pending.length === 0 ? value : concatBytes([pending, value]);
                drainFrames();
              }
            } finally {
              reader.releaseLock();
            }
          }
          drainFrames();

          if (hadError) {
            // If we already streamed partial text, emit a normal finish_reason="stop"
            // so the client treats this as a complete (truncated) response rather than
            // retrying and accumulating duplicate partial outputs (#b655de7b).
            // For tool calls, use "stop" (not "tool_calls") because the arguments
            // may be truncated mid-JSON — "tool_calls" signals the client to
            // parse and execute, which would fail on incomplete JSON.
            if (roleEmitted && (totalText || hasReasoning || sawToolCalls)) {
              emit(
                `data: ${JSON.stringify({
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                })}\n\n`
              );
              emit("data: [DONE]\n\n");
              controller.close();
              return;
            }
            // No text was streamed — emit the error so the 5xx failover can retry.
            emit(
              `data: ${JSON.stringify({
                error: { message: hadError, type: "windsurf_error", code: "upstream_error" },
              })}\n\n`
            );
            emit("data: [DONE]\n\n");
            controller.close();
            return;
          }

          // If nothing was streamed but we got a response, treat the decoded
          // text as the full reply (unary response path — raw protobuf, no framing).
          // Include hasReasoning so GLM reasoning-only responses (field 9, no field 3)
          // are not silently dropped.
          if (!roleEmitted && (totalText || hasReasoning)) {
            emit(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
                ],
              })}\n\n`
            );
            if (totalText) {
              emit(
                `data: ${JSON.stringify({
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: totalText }, finish_reason: null }],
                })}\n\n`
              );
            }
          }

          // Finish chunk — use "tool_calls" finish_reason if we emitted any tool calls
          const finishPayload: Record<string, unknown> = {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: sawToolCalls ? "tool_calls" : "stop" }],
          };
          if (promptTokens > 0 || completionTokens > 0) {
            finishPayload.usage = {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            };
          }
          emit(`data: ${JSON.stringify(finishPayload)}\n\n`);
          emit("data: [DONE]\n\n");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emit(
            `data: ${JSON.stringify({
              error: { message: `Windsurf stream error: ${msg}`, type: "windsurf_error" },
            })}\n\n`
          );
          emit("data: [DONE]\n\n");
        }

        controller.close();
      },
    });

    return new Response(sseStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}

// Exposed for unit tests only.
export const __test = {
  readVarint,
  decodeGetChatMessageResponse,
  decodeChatToolCall,
  encodeString,
  encodeMessage,
  encodeField,
  encodeBoolField,
  buildChatToolCall,
  buildChatMessagePrompt,
  buildChatToolDefinition,
  buildChatToolChoice,
  buildMetadata,
  grpcWebFrame,
  sanitizeJsonSchema,
  openaiToolsToWs,
  openaiToolChoiceToWs,
  roleToSource,
  resolveWsModelId,
  detectOs,
  detectHardware,
  // Access the private transformToSSE via an unbound reference for testing.
  // The method is arrow-bound in the class, so we extract it via prototype.
  transformToSSE: WindsurfExecutor.prototype.transformToSSE as (
    upstream: Response,
    model: string,
    stream: boolean,
    hasTools: boolean
  ) => Response,
};
