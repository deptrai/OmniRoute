# Windsurf GLM-5.2 — Tool Calling & Streaming Fixes

> Tài liệu kỹ thuật mô tả các bản sửa lỗi cho Windsurf executor khi xử lý tool calls và streaming với model GLM-5.2 qua Claude Code.
>
> **Phạm vi**: 7 commit từ `069160aca` đến `77ba4ebc0` (2026-07-03).
> **Files affected**: `open-sse/executors/windsurf.ts`, `open-sse/handlers/chatCore.ts`, `open-sse/services/errorClassifier.ts`, `open-sse/translator/response/openai-responses.ts`, `open-sse/utils/streamHelpers.ts`.

---

## Bối cảnh

Windsurf (từ v3.8) là OAuth provider dùng gRPC-web/Connect streaming protocol. Khi Claude Code gửi request qua OmniRoute → Windsurf → GLM-5.2, một loạt bug khiến tool calls không hoạt động:

- **366 tools gửi lên nhưng chỉ 62 được giữ** (83% bị drop) → model không thấy MCP tools → loop Bash commands thay vì gọi tool đúng.
- **Tool call streaming bị split thành nhiều entry** thay vì merge vào một → Claude translator tạo nhiều `content_block_start` → client nhận tool call rời rạc.
- **GLM-5.2 stream text qua field 9 (`delta_thinking`)** thay vì field 3 (`delta_text`) → client không nhận được nội dung.
- **Content policy block trigger account rotation vô ích** → burn fallback accounts cho lỗi deterministic.
- **Crash `Error in flush: Cannot read properties of null (reading 'choices')`** khi response bị null.

---

## Danh sách fix theo commit

### 1. `069160aca` — Fix native tool call streaming cho GLM-5.2

**File**: `open-sse/executors/windsurf.ts`

4 bug ngăn Claude Code dùng tool qua Windsurf/GLM-5.2:

#### 1.1. `sanitizeJsonSchema` strip property names

Hàm `sanitizeJsonSchema` (dòng 677) dùng filter `KEEP` cho keys, nhưng keys của `properties` là **tên property tùy ý** (`file_path`, `expression`...) → bị filter bỏ → schema rỗng.

**Fix**: Special-case key `properties` — không filter keys, mà recursively sanitize từng property value (dòng 719-730).

#### 1.2. `decodeChatToolCall` trả null cho arguments-only frames

Windsurf stream tool call arguments qua nhiều frame. Frame đầu có `id` + `name`, frame sau chỉ có `arguments_json` (field 3). `decodeChatToolCall` (dòng 562) trả `null` nếu thiếu `id` hoặc `name` → drop tất cả argument fragments.

**Fix**: Trả partial tool call khi có bất kỳ field nào present.

#### 1.3. Tool call emission dùng incrementing index per frame

Mỗi frame tạo `index` mới → Claude translator tạo `content_block_start` riêng per frame → tool call bị split.

**Fix**: Dùng `toolCallMap` (dòng 1029) keyed by `id` hoặc `name` — arguments-only frames merge vào `lastToolCallKey` (dòng 1034).

#### 1.4. GLM-5.2 stream text qua field 9 (`delta_thinking`)

GLM-5.2 gửi text content qua protobuf field 9 (`delta_thinking`) thay vì field 3 (`delta_text`). Code chỉ emit field 3 → client nhận response rỗng.

**Fix**: Cũng emit `deltaThinking` (dòng 1134).

> **Lưu ý**: Fix này được refine trong commit `87743bdf6` — gate `deltaThinking` emission chỉ cho GLM models (`/glm/i.test(model)`) để tránh leak reasoning tokens của các model khác.

---

### 2. `ab00f1785` — Skip account rotation cho content policy blocks + fix flush null crash

**Files**: `open-sse/services/errorClassifier.ts`, `open-sse/handlers/chatCore.ts`, `open-sse/translator/response/openai-responses.ts`

#### 2.1. Content policy block detection

Content policy blocks (vd: "Your request was blocked by our content policy") là **deterministic** — cùng payload sẽ bị block trên mọi account. Code cũ classify thành `SERVER_ERROR` generic → trigger 5xx account rotation failover → waste time + burn accounts.

**Fix trong `errorClassifier.ts`**:

- Thêm `CONTENT_POLICY_BLOCK` vào `PROVIDER_ERROR_TYPES` (dòng 79).
- Thêm `CONTENT_POLICY_BLOCK_SIGNALS` (dòng 101-109) với các pattern: `blocked by our content policy`, `blocked by content policy`, `content policy violation`, `content_policy_violation`, `sensitive or unsafe content`, `content filter`, `safety filter`.
- Export `CONTENT_POLICY_BLOCK_REGEX` (dòng 110).
- `classifyProviderError` (dòng 187-188) check `CONTENT_POLICY_BLOCK_REGEX` **trước** generic 5xx classification.

**Fix trong `chatCore.ts`**:

- Windsurf 5xx failover (dòng 2428-2437) peek error body — nếu match `CONTENT_POLICY_BLOCK_REGEX`, skip account rotation, fall through to normal error path.
- Error handler (dòng 3270-3283) record content policy block như per-request error — account stays active, không disable.

#### 2.2. Fix `Error in flush: Cannot read properties of null (reading 'choices')`

**Fix trong `openai-responses.ts`** (dòng 76): Guard `if (!chunk || !chunk.choices?.length) return [];` — trả early khi chunk null/empty thay vì crash khi access `chunk.choices[0]`.

---

### 3. `b348f93cd` — Progressive tool schema stripping

**File**: `open-sse/executors/windsurf.ts`

#### Vấn đề

Claude Code với 16 MCP servers gửi **366 tools (~150KB)**. Budget cũ 50KB với flat truncation chỉ giữ **62 tools (17%)** — toàn bộ Claude Code builtins, drop mọi MCP tool. Model fallback sang Bash commands, loop verbosely cố gọi MCP tools không có trong function list.

#### Fix

Progressive stripping dựa trên remaining budget (dòng 669-672, 789-819):

| Tier       | Điều kiện     | Schema                                | Description   | Mục đích                              |
| ---------- | ------------- | ------------------------------------- | ------------- | ------------------------------------- |
| **Tier 1** | budget > 30KB | Full sanitized schema + 200-char desc | Đầy đủ params | Model biết exact params               |
| **Tier 2** | budget > 10KB | `{"type":"object"}` + 120-char desc   | Type only     | Model biết tool tồn tại, guess params |
| **Tier 3** | budget > 0    | `{}` + 60-char desc                   | Name only     | Model biết tool tồn tại               |
| **Drop**   | budget = 0    | —                                     | —             | Log warning với dropped tool names    |

**Constants** (dòng 669-674):

- `WS_TOOLS_SIZE_BUDGET = 52000` (tăng từ 50KB, gần ~57KB hard limit).
- `WS_TIER2_THRESHOLD = 30000`.
- `WS_TIER3_THRESHOLD = 10000`.
- `WS_MAX_TOOL_DESC_LEN = 200`.

**Cross-validate toolChoice** (dòng 929-937): Nếu forced tool bị drop bởi budget, clear `toolChoice` để tránh Windsurf 400/502 cho tool không tồn tại.

**Kết quả**: 366 tools → 278 kept (76%, tăng từ 17%).

---

### 4. `98115431a` — Prioritize MCP tools over builtins cho tier-1

**File**: `open-sse/executors/windsurf.ts`

Claude Code gửi builtins trước (Agent, Bash, Edit...) → consume tier-1 budget. MCP tools (`mcp__*`) rơi vào tier 2/3 hoặc bị drop.

**Fix**: Reorder — MCP tools trước, builtins sau. MCP tools nhận tier-1 full schema (model cần param info), builtins tolerate stripped tier 2/3 (model đã biết well).

> **Lưu ý**: Fix này được refine trong commit `77ba4ebc0` — tách critical builtins ra trước MCP tools vì GLM-5.2 nhầm params khi schema bị strip.

---

### 5. `87743bdf6` — 9 code review patches

**File**: `open-sse/executors/windsurf.ts` (+ `errorClassifier.ts`)

Patches từ adversarial code review (Blind Hunter + Edge Case Hunter):

#### High severity

**5.1. Tool call name lost nếu first frame có empty name** (dòng 1214-1217)

- Buffer emission cho đến khi name arrives. Nếu first frame chỉ có `id` không `name`, đợi frame sau có name mới emit.

**5.2. Same tool call split thành 2 entry khi id arrives sau name** (dòng 1171-1177)

- Track `hasId` flag. Khi id absent, dùng name-based keying. Khi id arrives sau, merge vào entry existing thay vì tạo entry mới.

**5.3. `deltaThinking` emit as content cho ALL models** (dòng 1133-1134)

- Gate `/glm/i.test(model)` — chỉ GLM models stream text qua field 9. Các model khác dùng field 9 cho reasoning tokens thật → không leak.

**5.4. `finish_reason: "tool_calls"` trên error path** (dòng 1311-1313)

- Dùng `"stop"` thay vì `"tool_calls"` khi args có thể bị truncated mid-JSON. `"tool_calls"` báo client parse + execute → fail trên incomplete JSON.

#### Medium severity

**5.5. Two tool calls cùng name không id bị merge** (dòng 1172-1176)

- Khi name collision detected, tạo entry mới với unique key `${tc.name}#${nextToolCallIndex}`.

#### Low severity

**5.6. `sanitizeJsonSchema` throw trên `properties: null`** (dòng 724)

- Guard `if (v && typeof v === "object" && !Array.isArray(v))` trước `Object.entries(v)` — tránh crash trên malformed schema.

**5.7. `hasTools` param unused trong `transformToSSE`** (dòng 1157)

- Gate tool call field parsing trên `hasTools` — tránh false positives khi parse tool call fields trên response không có tools.

**5.8. Trailer error regex quá broad** (dòng 1102)

- Regex cụ thể: `rate limit|internal error|invalid_request|unauthorized|forbidden|content policy|safety filter` — tránh false positive từ benign messages chứa chữ "error".

**5.9. `policy violation` signal quá generic** (`errorClassifier.ts`)

- Remove bare `policy violation`, giữ chỉ `content policy violation` và cụm cụ thể — tránh misclassify non-content-policy errors.

---

### 6. `59b00293b` — 2 deferred code review findings

**File**: `open-sse/executors/windsurf.ts`

#### 6.1. `sanitizeJsonSchema` strip validation constraints (#5)

`sanitizeJsonSchema` strip các validation constraints (`additionalProperties`, `minimum`, `maximum`, `pattern`...) → model hallucinate extra fields hoặc generate out-of-range values mà tool reject runtime.

**Fix** (dòng 698-711): Thêm tất cả validation constraints vào `KEEP` set:

- `additionalProperties`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`
- `minLength`, `maxLength`, `pattern`, `format`
- `minItems`, `maxItems`, `uniqueItems`, `multipleOf`

Các field này nhỏ (booleans, numbers, short strings) → size impact minimal.

#### 6.2. `lastToolCallKey` merge ambiguity với parallel tool calls (#6)

Khi multiple tool calls stream song song, arguments-only frames (no id, no name) luôn route tới `lastToolCallKey` → corrupt argument routing.

**Fix** (dòng 1040, 1182-1184, 1207): Thêm `toolCallKeysByPos: Map<number, string>` — map protobuf array position → tool call key. Arguments-only frames dùng array position để tìm đúng tool call. Fallback `lastToolCallKey` cho sequential streaming (backward compatible).

---

### 7. `77ba4ebc0` — Prioritize critical builtins cho tier-1 full schema

**File**: `open-sse/executors/windsurf.ts`

#### Vấn đề

Commit `98115431a` ưu tiên MCP tools trước **tất cả** builtins → Write/Edit/Read bị đẩy xuống Tier 2 (`{"type":"object"}` — không thấy params) → GLM-5.2 **guess params sai**:

- Gửi `relative_path` thay vì `file_path` cho Write.
- Gửi `new_string`/`old_string` (params của Edit) thay vì `content` cho Write.

Session `a34f9548` ghi nhận 2/5 Write calls dùng sai params → `InputValidationError`.

#### Fix (dòng 755-772)

Tạo `WS_CRITICAL_BUILTINS` set — những tool model dùng thường xuyên nhất, cần exact param info:

```typescript
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
```

Thứ tự ưu tiên mới:

1. **Critical builtins** (Write, Edit, Read, Bash...) → Tier 1 full schema.
2. **MCP tools** (`mcp__*`) → Tier 1/2 tùy budget.
3. **Other builtins** (Agent, Task...) → Tier 2/3.

#### Verification

Session `f3d29523` (sau fix): **0/4 Write calls dùng sai params**, 0 `InputValidationError`, 0 connection drop, 12/12 streams complete.

---

## Tóm tắt files thay đổi

| File                                               | LOC  | Vai trò                                                                                            |
| -------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| `open-sse/executors/windsurf.ts`                   | +623 | Core executor — protobuf encode/decode, tool schema stripping, tool call streaming, error handling |
| `open-sse/handlers/chatCore.ts`                    | +141 | Content policy block detection trong 5xx failover, error classification routing                    |
| `open-sse/services/errorClassifier.ts`             | +21  | `CONTENT_POLICY_BLOCK` error type, regex signals, classification logic                             |
| `open-sse/translator/response/openai-responses.ts` | +2   | Null guard cho `chunk.choices`                                                                     |
| `open-sse/utils/streamHelpers.ts`                  | +2   | Null guard trong SSE parsing                                                                       |

---

## Key functions & constants (line references)

### `open-sse/executors/windsurf.ts`

| Symbol                         | Dòng      | Mô tả                                                                    |
| ------------------------------ | --------- | ------------------------------------------------------------------------ |
| `buildGetChatMessageRequest`   | 379       | Build protobuf request payload                                           |
| `decodeGetChatMessageResponse` | 484       | Decode response — extract `deltaText`, `deltaThinking`, `deltaToolCalls` |
| `decodeChatToolCall`           | 562       | Decode tool call — return partial khi any field present                  |
| `sanitizeJsonSchema`           | 677       | Strip non-essential schema fields, keep validation constraints           |
| `WS_TOOLS_SIZE_BUDGET`         | 670       | 52000 bytes (under ~57KB hard limit)                                     |
| `WS_TIER2_THRESHOLD`           | 671       | 30000 bytes                                                              |
| `WS_TIER3_THRESHOLD`           | 672       | 10000 bytes                                                              |
| `openaiToolsToWs`              | 738       | Convert OpenAI tools → Windsurf format với progressive stripping         |
| `WS_CRITICAL_BUILTINS`         | 755       | Set builtins cần tier-1 full schema                                      |
| `toolCallMap`                  | 1029      | Stable index per tool call (keyed by id/name)                            |
| `lastToolCallKey`              | 1034      | Fallback cho arguments-only frames (sequential streaming)                |
| `toolCallKeysByPos`            | 1040      | Map array position → tool call key (parallel streaming)                  |
| `isGlmModel` check             | 1133      | Gate `deltaThinking` emission cho GLM models only                        |
| Error path `finish_reason`     | 1314-1321 | Dùng `"stop"` thay vì `"tool_calls"` khi args truncated                  |

### `open-sse/services/errorClassifier.ts`

| Symbol                         | Dòng    | Mô tả                                      |
| ------------------------------ | ------- | ------------------------------------------ |
| `CONTENT_POLICY_BLOCK`         | 79      | Error type trong `PROVIDER_ERROR_TYPES`    |
| `CONTENT_POLICY_BLOCK_SIGNALS` | 101-109 | Array pattern signals                      |
| `CONTENT_POLICY_BLOCK_REGEX`   | 110     | Compiled regex                             |
| `classifyProviderError`        | 187-188 | Check content policy **trước** generic 5xx |

### `open-sse/handlers/chatCore.ts`

| Symbol                | Dòng      | Mô tả                                                          |
| --------------------- | --------- | -------------------------------------------------------------- |
| Windsurf 5xx failover | 2428-2437 | Peek body, skip rotation nếu content policy block              |
| Error handler         | 3270-3283 | Content policy block = per-request error, account stays active |

---

## Verification

### Typecheck & Lint

```bash
npm run typecheck:core        # PASS
npx eslint open-sse/executors/windsurf.ts  # PASS
```

### End-to-end test

Test với Claude Code qua `windsurf/glm-5.2`:

| Metric                        | Trước fix    | Sau fix                                 |
| ----------------------------- | ------------ | --------------------------------------- |
| Tools retained                | 62/366 (17%) | 278/366 (76%)                           |
| Write dùng sai params         | 2/5 lần      | 0/4 lần                                 |
| `InputValidationError`        | 2 lần        | 0 lần                                   |
| Connection closed mid-stream  | 1 lần        | 0 lần                                   |
| Stream crashes (`flush null`) | 1 lần        | 0 lần                                   |
| MCP tool calls hoạt động      | Không        | Có (`vibervn-context-engine`, `serena`) |

### Known limitations

- **WebSearch tool của Claude Code**: Trả meta-description thay vì kết quả thật khi route qua Windsurf — do WebSearch cần Anthropic backend, không phải lỗi OmniRoute.
- **GLM-5.2 verbose**: Model có đặc tính nói nhiều trước khi làm (avg ~200 chars/text message) — đây là model characteristic, không phải bug.
- **Windsurf max output token**: Stream dài (>120s, >15K output tokens) có thể bị Windsurf backend cắt — không control được qua protobuf request (không có field `max_tokens`).

---

## Commit history

| Commit      | Ngày             | Mô tả                                                                  |
| ----------- | ---------------- | ---------------------------------------------------------------------- |
| `069160aca` | 2026-07-03 04:59 | Fix native tool call streaming cho GLM-5.2                             |
| `ab00f1785` | 2026-07-03 05:10 | Skip account rotation cho content policy blocks + fix flush null crash |
| `b348f93cd` | 2026-07-03 05:26 | Progressive tool schema stripping                                      |
| `98115431a` | 2026-07-03 05:37 | Prioritize MCP tools over builtins cho tier-1                          |
| `87743bdf6` | 2026-07-03 05:44 | 9 code review patches                                                  |
| `59b00293b` | 2026-07-03 06:01 | 2 deferred code review findings                                        |
| `77ba4ebc0` | 2026-07-03 06:08 | Prioritize critical builtins cho tier-1 full schema                    |
