/**
 * Windsurf / Devin CLI MITM handler — CJS version for server.cjs.
 *
 * Pipeline (inbound: Devin CLI → OmniRoute):
 *   1. Split Connect-RPC frames from bodyBuffer
 *   2. Decode GetChatMessageRequest protobuf (first 0x00 frame)
 *   3. Translate to Anthropic /v1/messages request
 *   4. fetchRouter(anthropicBody, "/v1/messages") → Anthropic SSE
 *   5. Parse each SSE event → buildGetChatMessageResponse(delta) → buildConnectFrame(0x00)
 *   6. message_stop → end frame 0x02 (empty = success)
 *   7. error SSE event → end frame 0x02 with JSON error
 *
 * Ported from 9router src/mitm/handlers/windsurf.js, adapted for OmniRoute.
 */
"use strict";

const {
  CHAT_MESSAGE_SOURCE,
  splitConnectFrames,
  decodeGetChatMessageRequest,
  buildGetChatMessageResponse,
  buildConnectFrame,
  mapConnectErrorToAnthropic,
} = require("./windsurfProtobuf.cjs");

// ─── Model UID → OmniRoute alias map ──────────────────────────────────────────
// Maps upstream Windsurf modelUid → OmniRoute alias so /v1/messages routes
// to WindsurfExecutor. Keep in sync with open-sse/executors/windsurf.ts.
const WINDSURF_MODEL_UID_TO_ALIAS = {
  "claude-sonnet-4-6-thinking": "ws/sonnet-4.6",
  "claude-opus-4-8-medium": "ws/opus-4.8",
  "glm-5-2": "ws/glm-5-2",
  "glm-5-2-max-1m": "ws/glm-5-2",
  "swe-1-6": "ws/swe-1-6",
  "swe-1-6-fast": "ws/swe-1-6",
  "MODEL_MINIMAX_M2_1": "ws/minimax-m2.7",
};

// CHAT_MESSAGE_SOURCE → Anthropic role (inverse of buildChatMessagePrompt)
const SOURCE_TO_ROLE = {
  1: "user",
  2: "assistant",
  4: "tool",
  5: "system",
};

/**
 * Resolve upstream modelUid → OmniRoute alias.
 * Priority: UI alias map → auto-map → normalized fallback.
 */
function resolveModelAlias(modelUid, uiAlias) {
  if (uiAlias) {
    if (typeof uiAlias === "string") return uiAlias;
    if (typeof uiAlias === "object") {
      if (uiAlias[modelUid]) return uiAlias[modelUid];
      const vals = Object.values(uiAlias);
      if (vals.length > 0) return vals[0];
    }
  }
  if (WINDSURF_MODEL_UID_TO_ALIAS[modelUid]) return WINDSURF_MODEL_UID_TO_ALIAS[modelUid];
  // Strip variant suffix: "-max", "-max-1m", "-fast"
  const normalized = modelUid.replace(/-(?:max(?:-\w+)?|fast)$/i, "");
  if (normalized !== modelUid && WINDSURF_MODEL_UID_TO_ALIAS[normalized]) {
    return WINDSURF_MODEL_UID_TO_ALIAS[normalized];
  }
  return null;
}

/**
 * Translate decoded Windsurf GetChatMessageRequest → Anthropic /v1/messages body.
 */
function translateToAnthropic(decoded, mappedModel) {
  const body = { stream: true };

  const systemBlocks = [];
  if (decoded.system) {
    systemBlocks.push({ type: "text", text: decoded.system });
  }

  const messages = [];
  for (const m of decoded.messages) {
    const role = SOURCE_TO_ROLE[m.source] || "user";
    if (role === "system") {
      if (m.prompt) systemBlocks.push({ type: "text", text: m.prompt });
      continue;
    }
    if (role === "tool") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId || "", content: m.prompt || "" }],
      });
      continue;
    }
    const content = [];
    if (m.thinking) content.push({ type: "thinking", thinking: m.thinking });
    if (m.prompt) content.push({ type: "text", text: m.prompt });
    if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      for (const tc of m.toolCalls) {
        let input = {};
        try { input = JSON.parse(tc.arguments_json || tc.arguments || "{}"); } catch { /* malformed */ }
        content.push({ type: "tool_use", id: tc.id || "", name: tc.name || "", input });
      }
    }
    if (content.length === 0) content.push({ type: "text", text: "" });
    messages.push({ role, content });
  }

  if (systemBlocks.length > 0) body.system = systemBlocks;
  body.messages = messages;

  // Tools: Windsurf ChatToolDefinition → Anthropic tools
  if (Array.isArray(decoded.tools) && decoded.tools.length > 0) {
    body.tools = decoded.tools.map((t) => {
      let inputSchema = { type: "object", properties: {} };
      try { inputSchema = JSON.parse(t.inputSchemaStr || "{}"); } catch { /* malformed */ }
      return { name: t.name, description: t.description || "", input_schema: inputSchema };
    });
  }

  // max_tokens: prefer maxTokens (field 2) over maxNewlines * 400
  const cfg = decoded.configuration;
  if (cfg && cfg.maxTokens) {
    body.max_tokens = Math.min(cfg.maxTokens, 128000);
  } else if (cfg && cfg.maxNewlines) {
    body.max_tokens = Math.min(cfg.maxNewlines * 400, 128000);
  } else {
    body.max_tokens = 128000;
  }

  // Forward sampling params
  if (cfg) {
    if (typeof cfg.temperature === "number" && cfg.temperature > 0) body.temperature = cfg.temperature;
    if (typeof cfg.topP === "number" && cfg.topP > 0) body.top_p = cfg.topP;
    if (typeof cfg.topK === "number" && cfg.topK > 0) body.top_k = cfg.topK;
  }

  body.model = mappedModel || decoded.modelUid || "ws/sonnet-4.6";
  return body;
}

// Anthropic stop_reason string → Windsurf stop_reason enum
const STOP_REASON_MAP = {
  end_turn: 1,
  stop_sequence: 1,
  max_tokens: 2,
  tool_use: 3,
};

// Inverse of mapConnectErrorToAnthropic
function mapAnthropicErrorToConnectCode(anthropicType) {
  const map = {
    authentication_error: "unauthenticated",
    permission_error: "permission_denied",
    rate_limit_error: "resource_exhausted",
    invalid_request_error: "invalid_argument",
    api_error: "internal",
    overloaded_error: "unavailable",
  };
  return map[anthropicType] || "internal";
}

/**
 * Parse Anthropic SSE stream and emit Connect-RPC frames to client response.
 */
async function pipeAnthropicSseAsConnectFrames(routerRes, res) {
  res.writeHead(routerRes.status || 200, {
    "Content-Type": "application/connect+proto",
    "Connect-Protocol-Version": "1",
    "Transfer-Encoding": "chunked",
  });

  if (!routerRes.body) {
    res.end(buildConnectFrame(0x02, Buffer.from("{}")));
    return;
  }

  const reader = routerRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let endSent = false;
  const toolUseState = {}; // index → { id, name, args }

  const sendEnd = (errorObj) => {
    if (endSent) return;
    endSent = true;
    const payload = errorObj
      ? Buffer.from(JSON.stringify({ error: errorObj }))
      : Buffer.from("{}");
    res.write(buildConnectFrame(0x02, payload));
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = sseBuffer.indexOf("\n\n")) !== -1) {
        const rawEvent = sseBuffer.slice(0, idx);
        sseBuffer = sseBuffer.slice(idx + 2);
        processSseEvent(rawEvent);
      }
    }
    if (sseBuffer.trim()) processSseEvent(sseBuffer);
  } finally {
    if (!endSent) sendEnd();
    res.end();
  }

  function processSseEvent(rawEvent) {
    let eventType = "";
    let dataStr = "";
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
    }
    if (!dataStr) return;
    if (dataStr === "[DONE]" || dataStr.startsWith("[DONE]")) return;

    let data;
    try { data = JSON.parse(dataStr); } catch { return; }

    switch (eventType) {
      case "content_block_start": {
        const block = data.content_block;
        if (block?.type === "tool_use") {
          const idx = data.index ?? 0;
          toolUseState[idx] = { id: block.id || "", name: block.name || "", args: "" };
        }
        break;
      }
      case "content_block_delta": {
        const delta = data.delta;
        if (!delta) break;
        if (delta.type === "text_delta") {
          res.write(buildConnectFrame(0x00, buildGetChatMessageResponse({ delta_text: delta.text })));
        } else if (delta.type === "thinking_delta") {
          res.write(buildConnectFrame(0x00, buildGetChatMessageResponse({ delta_thinking: delta.thinking })));
        } else if (delta.type === "input_json_delta") {
          const idx = data.index ?? 0;
          if (toolUseState[idx]) toolUseState[idx].args += delta.partial_json || "";
        }
        break;
      }
      case "content_block_stop": {
        const idx = data.index ?? 0;
        const tus = toolUseState[idx];
        if (tus) {
          res.write(buildConnectFrame(0x00, buildGetChatMessageResponse({
            delta_tool_calls: [{ id: tus.id, name: tus.name, arguments: tus.args || "{}" }],
          })));
          delete toolUseState[idx];
        }
        break;
      }
      case "message_delta": {
        const delta = data.delta || {};
        const usage = data.usage || {};
        if (delta.stop_reason || usage) {
          const stopReason = delta.stop_reason ? (STOP_REASON_MAP[delta.stop_reason] ?? 1) : null;
          const usageOut = usage.output_tokens != null ? {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            cache_read_tokens: usage.cache_read_input_tokens || 0,
          } : null;
          res.write(buildConnectFrame(0x00, buildGetChatMessageResponse({
            ...(stopReason != null && { stop_reason: stopReason }),
            ...(usageOut && { usage: usageOut }),
          })));
        }
        break;
      }
      case "message_stop": {
        sendEnd();
        break;
      }
      case "error": {
        const e = data.error || data;
        sendEnd({
          code: mapAnthropicErrorToConnectCode(e.type),
          message: e.message || "Anthropic stream error",
        });
        break;
      }
      default:
        break;
    }
  }
}

/**
 * MITM intercept entry point for Windsurf / Devin CLI.
 *
 * @param {object} req - Incoming HTTP request (server.codeium.com Connect-RPC)
 * @param {object} res - Server response
 * @param {Buffer} bodyBuffer - Raw request body (1+ Connect-RPC frames)
 * @param {function} passthrough - Fallback forward raw to upstream
 * @param {object} opts - { routerBaseUrl, routerApiKey, getMitmAlias }
 */
async function intercept(req, res, bodyBuffer, passthrough, opts = {}) {
  const routerBaseUrl = opts.routerBaseUrl || "http://127.0.0.1:20128";
  const routerApiKey = opts.routerApiKey || "";
  const getMitmAlias = opts.getMitmAlias || (() => null);

  // 0. Decode protobuf
  let decoded = null;
  let decodeError = null;
  try {
    const frames = splitConnectFrames(bodyBuffer);
    const dataFrame = frames.find((f) => f.flags === 0x00);
    if (dataFrame) decoded = decodeGetChatMessageRequest(dataFrame.payload);
    else decodeError = new Error("No data frame (0x00) in Connect-RPC request body");
  } catch (e) { decodeError = e; }

  // 1. Decode fail → passthrough
  if (!decoded) {
    console.error(`[Windsurf MITM] decode failed: ${decodeError?.message} → passthrough`);
    return passthrough(req, res, bodyBuffer);
  }

  // 2. Resolve model
  const uiAlias = getMitmAlias("windsurf");
  const resolvedModel = resolveModelAlias(decoded.modelUid, uiAlias);

  // 3. Model not resolved → passthrough
  if (!resolvedModel) {
    console.error(`[Windsurf MITM] modelUid "${decoded.modelUid}" not in alias map → passthrough`);
    return passthrough(req, res, bodyBuffer);
  }

  // 4. Translate → forward to OmniRoute → re-encode Connect-RPC frames
  try {
    const anthropicBody = translateToAnthropic(decoded, resolvedModel);

    const url = `${routerBaseUrl.replace(/\/+$/, "")}/v1/messages`;
    const routerRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(routerApiKey && { Authorization: `Bearer ${routerApiKey}` }),
        "x-omniroute-source": "agent-bridge",
        "x-omniroute-agent": "windsurf",
      },
      body: JSON.stringify(anthropicBody),
    });

    if (routerRes.status !== 200) {
      const errText = await routerRes.text().catch(() => "");
      let errMsg = errText || `OmniRoute returned ${routerRes.status}`;
      let errCode = "internal";
      try {
        const parsed = JSON.parse(errText);
        if (parsed?.error?.type) errCode = mapAnthropicErrorToConnectCode(parsed.error.type);
        if (parsed?.error?.message) errMsg = parsed.error.message;
      } catch { /* keep raw text */ }
      res.writeHead(routerRes.status, {
        "Content-Type": "application/connect+proto",
        "Connect-Protocol-Version": "1",
        "Transfer-Encoding": "chunked",
      });
      res.end(buildConnectFrame(0x02, Buffer.from(JSON.stringify({ error: { code: errCode, message: errMsg } }))));
      return;
    }

    await pipeAnthropicSseAsConnectFrames(routerRes, res);
  } catch (error) {
    console.error(`[Windsurf MITM] ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(500, {
        "Content-Type": "application/connect+proto",
        "Connect-Protocol-Version": "1",
        "Transfer-Encoding": "chunked",
      });
    }
    res.end(buildConnectFrame(0x02, Buffer.from(JSON.stringify({
      error: { code: "internal", message: error.message },
    }))));
  }
}

module.exports = { intercept, translateToAnthropic, resolveModelAlias };
