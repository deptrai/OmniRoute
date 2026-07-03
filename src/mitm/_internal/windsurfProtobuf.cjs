/**
 * Windsurf Protobuf Encoder/Decoder — CJS version for server.cjs.
 *
 * Implements ConnectRPC protobuf wire format for Windsurf API (inbound MITM):
 *   - splitConnectFrames: split raw body into Connect-RPC frames
 *   - decodeGetChatMessageRequest: decode protobuf request from Devin CLI
 *   - buildGetChatMessageResponse: encode protobuf response back to Devin CLI
 *   - buildConnectFrame: wrap protobuf payload in Connect-RPC frame
 *
 * Ported from 9router open-sse/utils/windsurfProtobuf.js (inbound section).
 * The outbound builders (buildGetChatMessageRequest etc.) already exist in
 * open-sse/executors/windsurf.ts and are not duplicated here.
 */
"use strict";

const { randomUUID } = require("node:crypto");

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const WIRE_TYPE = { VARINT: 0, FIXED64: 1, LEN: 2, FIXED32: 5 };

const CHAT_MESSAGE_SOURCE = {
  UNSPECIFIED: 0,
  USER: 1,
  SYSTEM: 2,
  UNKNOWN: 3,
  TOOL: 4,
  SYSTEM_PROMPT: 5,
};

// ==================== PRIMITIVE ENCODING ====================

function encodeVarint(value) {
  const bytes = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}

function encodeField(fieldNum, wireType, value) {
  const tag = (fieldNum << 3) | wireType;
  const tagBytes = encodeVarint(tag);

  if (wireType === WIRE_TYPE.VARINT) {
    return concatArrays(tagBytes, encodeVarint(value));
  }

  if (wireType === WIRE_TYPE.LEN) {
    const dataBytes =
      typeof value === "string"
        ? textEncoder.encode(value)
        : value instanceof Uint8Array
          ? value
          : Buffer.isBuffer(value)
            ? new Uint8Array(value)
            : new Uint8Array(0);
    return concatArrays(tagBytes, encodeVarint(dataBytes.length), dataBytes);
  }

  if (wireType === WIRE_TYPE.FIXED64) {
    const valueBytes = new Uint8Array(8);
    const view = new DataView(valueBytes.buffer);
    if (typeof value === "bigint") {
      view.setBigUint64(0, value, true);
    } else {
      view.setFloat64(0, value, true);
    }
    return concatArrays(tagBytes, valueBytes);
  }

  return new Uint8Array(0);
}

function concatArrays(...arrays) {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ==================== PRIMITIVE DECODING ====================

/**
 * Decode a protobuf message into a Map<fieldNum, Array<{wireType, value}>>.
 * value is a Uint8Array for LEN fields, number for VARINT, Uint8Array for FIXED64/32.
 */
function decodeMessage(buf) {
  const fields = new Map();
  let offset = 0;

  while (offset < buf.length) {
    const [tag, newOffset] = readVarint(buf, offset);
    offset = newOffset;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;

    let entry;
    if (wireType === WIRE_TYPE.VARINT) {
      const [value, next] = readVarint(buf, offset);
      offset = next;
      entry = { wireType, value };
    } else if (wireType === WIRE_TYPE.LEN) {
      const [len, next] = readVarint(buf, offset);
      offset = next;
      const payload = buf.subarray(offset, offset + len);
      offset += len;
      entry = { wireType, value: new Uint8Array(payload) };
    } else if (wireType === WIRE_TYPE.FIXED64) {
      entry = { wireType, value: new Uint8Array(buf.subarray(offset, offset + 8)) };
      offset += 8;
    } else if (wireType === WIRE_TYPE.FIXED32) {
      entry = { wireType, value: new Uint8Array(buf.subarray(offset, offset + 4)) };
      offset += 4;
    } else {
      break; // unknown wire type
    }

    if (!fields.has(fieldNum)) fields.set(fieldNum, []);
    fields.get(fieldNum).push(entry);
  }

  return fields;
}

function readVarint(buf, offset) {
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

// ==================== INBOUND: DECODE REQUEST (Devin CLI → OmniRoute) ====================

/**
 * Pure Connect-RPC frame splitter.
 * Frame layout: [flags:1B][length:4B BE][payload:length B]
 *   flags 0x00 = data frame, 0x02 = end frame
 */
function splitConnectFrames(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const frames = [];
  let pos = 0;
  const MAX_FRAME_SIZE = 10_000_000;
  while (pos + 5 <= buf.length) {
    const flags = buf[pos];
    const length = (buf[pos + 1] << 24) | (buf[pos + 2] << 16) | (buf[pos + 3] << 8) | buf[pos + 4];
    if (length < 0 || length > MAX_FRAME_SIZE) break;
    if (pos + 5 + length > buf.length) break;
    const payload = buf.subarray(pos + 5, pos + 5 + length);
    frames.push({ flags, payload: new Uint8Array(payload) });
    pos += 5 + length;
  }
  return frames;
}

function decodeMetadata(data) {
  const fields = decodeMessage(data);
  const get = (n) => (fields.has(n) ? textDecoder.decode(fields.get(n)[0].value) : "");
  return {
    ideName: get(1),
    extensionVersion: get(2),
    apiKey: get(3),
    locale: get(4),
    os: get(5),
    ideVersion: get(7),
    extensionName: get(12),
  };
}

function decodeToolCall(data) {
  try {
    const fields = decodeMessage(data);
    return {
      id: fields.has(1) ? textDecoder.decode(fields.get(1)[0].value) : "",
      name: fields.has(2) ? textDecoder.decode(fields.get(2)[0].value) : "",
      arguments_json: fields.has(3) ? textDecoder.decode(fields.get(3)[0].value) : "",
      invalid_json_str: fields.has(4) ? textDecoder.decode(fields.get(4)[0].value) : "",
    };
  } catch {
    return null;
  }
}

function decodeChatMessagePrompt(data) {
  const fields = decodeMessage(data);
  const messageId = fields.has(1) ? textDecoder.decode(fields.get(1)[0].value) : "";
  const source = fields.has(2) ? fields.get(2)[0].value : 0;
  const prompt = fields.has(3) ? textDecoder.decode(fields.get(3)[0].value) : "";
  const thinking = fields.has(11) ? textDecoder.decode(fields.get(11)[0].value) : null;
  const toolCallId = fields.has(7) ? textDecoder.decode(fields.get(7)[0].value) : null;
  const toolCalls = [];
  if (fields.has(6)) {
    for (const item of fields.get(6)) {
      const tc = decodeToolCall(item.value);
      if (tc) toolCalls.push(tc);
    }
  }
  return { messageId, source, prompt, thinking, toolCallId, toolCalls };
}

function decodeToolDefinition(data) {
  const fields = decodeMessage(data);
  return {
    name: fields.has(1) ? textDecoder.decode(fields.get(1)[0].value) : "",
    description: fields.has(2) ? textDecoder.decode(fields.get(2)[0].value) : "",
    inputSchemaStr: fields.has(3) ? textDecoder.decode(fields.get(3)[0].value) : "{}",
  };
}

function decodeConfiguration(data) {
  const fields = decodeMessage(data);
  const vint = (n) => (fields.has(n) ? fields.get(n)[0].value : 0);
  const f64 = (n) => {
    if (!fields.has(n)) return 0;
    const v = fields.get(n)[0].value;
    const view = new DataView(v.buffer, v.byteOffset, 8);
    return view.getFloat64(0, true);
  };
  return {
    numCompletions: vint(1),
    maxTokens: vint(2),
    maxNewlines: vint(3),
    temperature: f64(5),
    topK: vint(7),
    topP: f64(8),
  };
}

/**
 * Decode full GetChatMessageRequest protobuf payload.
 */
function decodeGetChatMessageRequest(payload) {
  const fields = decodeMessage(payload);
  const str = (n) => (fields.has(n) ? textDecoder.decode(fields.get(n)[0].value) : "");
  const vint = (n) => (fields.has(n) ? fields.get(n)[0].value : 0);

  const result = {
    metadata: fields.has(1) ? decodeMetadata(fields.get(1)[0].value) : null,
    system: str(2),
    messages: [],
    requestType: vint(7),
    configuration: fields.has(8) ? decodeConfiguration(fields.get(8)[0].value) : null,
    tools: [],
    cascadeId: str(16),
    plannerMode: vint(20),
    modelUid: str(21),
    executionId: str(22),
  };

  if (fields.has(3)) {
    for (const item of fields.get(3)) {
      result.messages.push(decodeChatMessagePrompt(item.value));
    }
  }

  if (fields.has(10)) {
    for (const item of fields.get(10)) {
      result.tools.push(decodeToolDefinition(item.value));
    }
  }

  return result;
}

// ==================== INBOUND: BUILD RESPONSE (OmniRoute → Devin CLI) ====================

function buildDeltaToolCall(tc) {
  const id = tc.id || "";
  const name = tc.name || "";
  const args = typeof tc.arguments === "string" ? tc.arguments : tc.arguments_json || "{}";
  return concatArrays(
    encodeField(1, WIRE_TYPE.LEN, id),
    encodeField(2, WIRE_TYPE.LEN, name),
    encodeField(3, WIRE_TYPE.LEN, args),
  );
}

function buildUsage(usage) {
  const fields = [];
  if (usage.input_tokens != null) fields.push(encodeField(2, WIRE_TYPE.VARINT, usage.input_tokens));
  if (usage.output_tokens != null) fields.push(encodeField(3, WIRE_TYPE.VARINT, usage.output_tokens));
  if (usage.cache_read_tokens != null) fields.push(encodeField(5, WIRE_TYPE.VARINT, usage.cache_read_tokens));
  if (usage.model_uid) fields.push(encodeField(9, WIRE_TYPE.LEN, usage.model_uid));
  return concatArrays(...fields);
}

/**
 * Build a GetChatMessageResponse protobuf payload.
 *   { delta_text, stop_reason, delta_tool_calls[], usage, delta_thinking }
 */
function buildGetChatMessageResponse(delta) {
  const fields = [];
  if (delta.delta_text != null) {
    fields.push(encodeField(3, WIRE_TYPE.LEN, delta.delta_text));
  }
  if (delta.stop_reason != null) {
    fields.push(encodeField(5, WIRE_TYPE.VARINT, delta.stop_reason));
  }
  if (Array.isArray(delta.delta_tool_calls)) {
    for (const tc of delta.delta_tool_calls) {
      fields.push(encodeField(6, WIRE_TYPE.LEN, buildDeltaToolCall(tc)));
    }
  }
  if (delta.usage) {
    fields.push(encodeField(7, WIRE_TYPE.LEN, buildUsage(delta.usage)));
  }
  if (delta.delta_thinking != null) {
    fields.push(encodeField(9, WIRE_TYPE.LEN, delta.delta_thinking));
  }
  return concatArrays(...fields);
}

/**
 * Wrap a protobuf payload in a Connect-RPC frame.
 * flags: 0x00 = data frame, 0x02 = end frame
 */
function buildConnectFrame(flags, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32BE(body.length, 0);
  return Buffer.concat([Buffer.from([flags]), lengthBytes, body]);
}

/**
 * Map Connect-RPC error code to Anthropic error type.
 */
function mapConnectErrorToAnthropic(connectError) {
  const map = {
    unauthenticated: { status: 401, type: "authentication_error" },
    permission_denied: { status: 403, type: "permission_error" },
    resource_exhausted: { status: 429, type: "rate_limit_error" },
    failed_precondition: { status: 403, type: "permission_error" },
    invalid_argument: { status: 400, type: "invalid_request_error" },
    internal: { status: 502, type: "api_error" },
    unavailable: { status: 529, type: "overloaded_error" },
  };
  const { status, type } = map[connectError.code] || { status: 502, type: "api_error" };
  return {
    status,
    error: { type: "error", error: { type, message: connectError.message } },
  };
}

module.exports = {
  CHAT_MESSAGE_SOURCE,
  splitConnectFrames,
  decodeGetChatMessageRequest,
  buildGetChatMessageResponse,
  buildConnectFrame,
  mapConnectErrorToAnthropic,
};
