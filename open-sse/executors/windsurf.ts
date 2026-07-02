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
 *   Cognition SWE:  swe-1, swe-1-5, swe-1-6, swe-1-6-fast, swe-1-lite
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
  "glm-5.2-max": "glm-5-2-max",
  "glm-5.1": "glm-5-1",
};

function resolveWsModelId(model: string): string {
  return MODEL_ALIAS_MAP[model] ?? model;
}

// ─── Minimal protobuf encoder ────────────────────────────────────────────────
//
// Implements only what is needed for GetChatMessageRequest.
// Wire types: 0 = varint, 2 = length-delimited.

function encodeVarint(value: number): Uint8Array {
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
function encodeVarintField(fieldNum: number, value: number): Uint8Array {
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

type WsChatMessage = { role: string; content: string; toolCallId?: string };

function buildChatMessagePrompt(msg: WsChatMessage): Uint8Array {
  const parts: Uint8Array[] = [
    encodeString(1, randomUUID()), // message_id
    encodeVarintField(2, roleToSource(msg.role)), // source enum
    encodeString(3, msg.content), // prompt (text content)
  ];
  if (msg.toolCallId) {
    parts.push(encodeString(7, msg.toolCallId)); // tool_call_id
  }
  return concatBytes(parts);
}

function buildGetChatMessageRequest(
  apiKey: string,
  model: string,
  messages: WsChatMessage[]
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
//   field 3  (string)  → delta_text      (content text delta)
//   field 4  (uint32)  → delta_tokens
//   field 5  (enum)    → stop_reason      (0=UNSPECIFIED, non-zero = done)
//   field 7  (message) → usage (ModelUsageStats)
//   field 9  (string)  → delta_thinking
//   field 13 (message) → completion_profile
//   field 15 (string)  → output_id
//
// ModelUsageStats (exa.codeium_common_pb.ModelUsageStats):
//   field 2 (uint64) → input_tokens
//   field 3 (uint64) → output_tokens

type DecodedResponse = {
  deltaText: string;
  deltaThinking: string;
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
        // delta_thinking (string)
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

  return { deltaText, deltaThinking, stopReason, inputTokens, outputTokens };
}

// ─── Convert OpenAI messages → Windsurf WsChatMessage[] ──────────────────────

type OpenAIMessage = {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
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
    out.push({ role, content, toolCallId: m.tool_call_id });
  }
  return out;
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
    const wsMessages = openAIMessagesToWs(rawMessages);

    if (wsMessages.length === 0) {
      wsMessages.push({ role: "user", content: "" });
    }

    // Build the protobuf request and frame it for Connect streaming protocol.
    // Connect streaming framing: 1 byte flags (0=no compression) + 4 bytes BE length + payload.
    const protoPayload = buildGetChatMessageRequest(apiKey, wsModel, wsMessages);
    const framedPayload = grpcWebFrame(protoPayload); // same format as gRPC-web data frame

    const url = this.buildUrl();
    const headers = this.buildHeaders(credentials);
    mergeUpstreamExtraHeaders(headers, upstreamExtraHeaders);

    log?.info?.("WS", `Windsurf → ${wsModel} (${wsMessages.length} messages)`);

    const upstream = await fetch(url, {
      method: "POST",
      headers,
      body: framedPayload,
      signal: signal ?? undefined,
    });

    if (!upstream.ok && upstream.status !== 200) {
      return { response: upstream, url, headers, transformedBody: protoPayload };
    }

    // Transform Connect binary response → SSE stream
    const sseResponse = this.transformToSSE(upstream, model, stream);
    return { response: sseResponse, url, headers, transformedBody: protoPayload };
  }

  /** Convert a Connect streaming response body into an OpenAI-compatible SSE stream.
   *
   *  Connect streaming framing: 1 byte flags + 4 bytes BE length + payload
   *    flags bit 0 (0x01): end of stream
   *    flags bit 1 (0x02): trailer frame (payload = key:value\n pairs)
   *  Data frames contain a GetChatMessageResponse protobuf message.
   */
  private transformToSSE(upstream: Response, model: string, _stream: boolean): Response {
    const responseId = `chatcmpl-ws-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    const sseStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        let roleEmitted = false;
        let totalText = "";
        let promptTokens = 0;
        let completionTokens = 0;
        let hadError: string | null = null;

        function emit(data: string) {
          controller.enqueue(enc.encode(data));
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
                  hadError = j.error.message;
                  return;
                }
              } catch {
                // not JSON, ignore
              }
              return;
            }

            // Data frame — decode as GetChatMessageResponse
            const resp = decodeGetChatMessageResponse(payload);

            if (resp.deltaText) {
              totalText += resp.deltaText;
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
            if (roleEmitted && totalText) {
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
          if (!roleEmitted && totalText) {
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

          // Finish chunk
          const finishPayload: Record<string, unknown> = {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
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
