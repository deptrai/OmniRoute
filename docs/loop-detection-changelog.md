# Loop Detection cho swe-1.7 — Changelog kỹ thuật

> Tài liệu ghi lại **toàn bộ code thay đổi của tôi** (luisphan) trên OmniRoute
> để fix lỗi `swe-1.7` model bị loop tool calls khi chạy qua Windsurf executor.
>
> Repo: `OmniRoute` — branch `production`
> File chính: `open-sse/executors/windsurf.ts`
> Thời gian: 2026-07-17

---

## Bối cảnh vấn đề

### Triệu chứng

Model `zai/swe-1.7` (chạy qua Windsurf executor) bị enters `tool_use` loops —
gọi đi gọi lại cùng một tool call với identical arguments:

- `Read` cùng file 4-5 lần liên tiếp
- `TaskUpdate(taskId="1", status="in_progress")` 5+ lần
- `TaskCreate` với content giống nhau
- Tổng cộng 23+ Read calls trong 1 session trước khi dừng

### Root cause

Windsurf API **rejects** `assistant` và `system` roles (502 error), buộc
`openAIMessagesToWs` phải convert **tất cả messages** sang `source=USER`.

Hậu quả: `swe-1.7` không phân biệt được tool_calls trước đó của chính nó với
user messages → lặp lại identical calls vô tận.

### Giải pháp đã chọn

**Loop Detection + Warning Injection** (inspired by `bytedance/deer-flow`):

- Scan assistant messages cho duplicate tool_calls
- Inject warning/hard-stop message khi phát hiện loop
- Zero overhead cho models không bị loop (glm-5.2, etc.)

---

## Commit 1: `6e5922e07` — Initial loop detection

**Message:**

```
fix(windsurf): detect and break tool call loops for swe-1.7
```

**Thresholds ban đầu:**

- `LOOP_WARN_THRESHOLD = 3` — warning sau 3 identical calls
- `LOOP_HARD_LIMIT = 5` — hard-stop sau 5 identical calls
- `LOOP_WINDOW_SIZE = 20` — sliding window 20 calls

**Thêm 2 functions:**

### `stableToolCallKey(name, argsJson)` — Hash tool call thành stable key

Bucketing logic per tool type:

| Tool                         | Bucket by                                                                       | Lý do                                  |
| ---------------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| `write`/`edit`/`str_replace` | Full args                                                                       | Content-sensitive — mỗi edit khác nhau |
| `read`/`read_file`           | Path only (lúc này)                                                             | Cùng file = loop, bỏ qua line range    |
| `bash`/`exec`                | Command prefix (100 chars)                                                      | Cùng prefix = có thể loop              |
| `TaskCreate`/`TodoWrite`     | Task content prefix (80 chars)                                                  | Cùng content = loop                    |
| `TaskUpdate`                 | taskId + status                                                                 | Cùng task + cùng status = loop         |
| Default                      | Salient fields (path, url, query, command, pattern, glob, cmd, file, file_path) | Fallback                               |

### `detectToolCallLoops(messages)` — Phát hiện loop

1. Collect tất cả tool_calls từ assistant messages
2. Hash mỗi call thành stable key
3. Sliding window 20 calls — count duplicates
4. Nếu max count >= 3 → inject `[LOOP DETECTED]` warning
5. Nếu max count >= 5 → inject `[FORCED STOP]` hard-stop
6. Warning message include state summary (top 5 repeated calls)

### Injection point

```typescript
// Sau khi openAIMessagesToWs process rawMessages
// Trước khi buildGetChatMessageRequest được gọi
const loopWarning = detectToolCallLoops(rawMessages);
if (loopWarning) {
  wsMessages.push({ role: "user", content: loopWarning });
  log?.info?.("WS", `[WINDSURF_LOOP] ${loopWarning.substring(0, 120)}`);
}
```

### Test kết quả (commit 1)

| Test                          | Model   | Kết quả                              |
| ----------------------------- | ------- | ------------------------------------ |
| 3x read same file             | swe-1.7 | ✅ Model dừng, trả final answer      |
| 5x TaskCreate identical       | swe-1.7 | ✅ FORCED STOP, model acknowledge    |
| glm-5.2 diverse tools         | glm-5.2 | ✅ Zero overhead                     |
| Mixed tools + parallel calls  | swe-1.7 | ✅ Hard-stop works                   |
| Anthropic API format          | swe-1.7 | ✅ Hard-stop works                   |
| Long conversation + late loop | swe-1.7 | ✅ Sliding window catches late loops |

---

## Commit 2: `bbd5118ae` — Tune: chunked reads + per-tool freq + faster hard-stop

**Message:**

```
fix(windsurf): tune loop detection — chunked reads, per-tool freq, faster hard-stop
```

**3 improvements:**

### 2.1 Read bucketing — include line ranges

**Trước:** `read` bucket by path only → chunked reads (1-100, 101-200, 201-300) bị false positive

**Sau:** Bucket by path + 50-line range chunks

```typescript
if (name === "read" || name === "read_file" || name === "Read") {
  const path = String(args.path || args.file_path || args.file || "");
  const start = String(args.start_line ?? args.startLine ?? args.offset ?? "");
  const end = String(args.end_line ?? args.endLine ?? args.limit ?? "");
  let rangeKey = "";
  if (start || end) {
    const s = Math.floor((Number(start) || 1 - 1) / 50) * 50;
    const e = Math.floor((Number(end) || 0) / 50) * 50;
    rangeKey = `:${s}-${e}`;
  }
  return `${name}:read:${path}${rangeKey}`;
}
```

→ Chunked reads (same path, diff ranges) **không bị flag**. Chỉ same path + same range 3x mới trigger.

### 2.2 Per-tool frequency detection

**Mới:** Catches same tool TYPE gọi nhiều lần với different args

```typescript
const LOOP_TOOL_FREQ_WARN = 12; // warn sau 12 calls cùng tool type
const LOOP_TOOL_FREQ_HARD = 18; // hard-stop sau 18 calls cùng tool type
```

→ Bắt được loops như 15x TaskCreate với content khác nhau, 20x read different files.

### 2.3 Hard-stop threshold lowered

- `LOOP_HARD_LIMIT`: 5 → **4** (nhanh hơn)

### 2.4 Added Read/Bash (capital) to bucketing

Claude Code dùng `Read`, `Bash` (viết hoa) — thêm vào bucketing logic.

### Test kết quả (commit 2)

Unit tests: **18/18 pass**

| #      | Case                             | Kết quả                   |
| ------ | -------------------------------- | ------------------------- |
| E1     | Chunked reads diff ranges        | ✅ null — không trigger   |
| E2     | Same path + same range 3x        | ✅ LOOP DETECTED          |
| E3     | Same path no range 3x            | ✅ LOOP DETECTED          |
| E4     | 4x same TaskUpdate               | ✅ FORCED STOP            |
| E5     | 12x read diff files              | ✅ freq warning           |
| E6     | 11x read diff files              | ✅ null (below threshold) |
| E7     | 18x read diff files              | ✅ FORCED STOP            |
| E8     | Mixed tools no repeat            | ✅ null                   |
| E9     | 20 reads in window               | ✅ FORCED STOP (freq)     |
| E10    | Read (capital) same path 3x      | ✅ LOOP DETECTED          |
| E11    | bash same prefix 3x (below freq) | ✅ null                   |
| E12-13 | Empty / only user                | ✅ null                   |
| E14    | 2x below threshold               | ✅ null                   |
| E15    | Diff TaskCreate content          | ✅ null                   |
| E16    | TaskUpdate 3x same + 1x diff     | ✅ LOOP DETECTED          |
| E17    | 1-50 (2x) + 51-100 (1x)          | ✅ null (below threshold) |
| E18    | Parallel 3x same batch           | ✅ LOOP DETECTED          |

E2E trên production:

| Test                     | Model   | Kết quả                                             |
| ------------------------ | ------- | --------------------------------------------------- |
| 4x TaskUpdate hard-stop  | swe-1.7 | ✅ "Task already updated"                           |
| Chunked reads (4 chunks) | swe-1.7 | ✅ "Read in 100-line chunks" — tiếp tục bình thường |
| 12x read diff files freq | swe-1.7 | ✅ "Read all 12 files" — summarize và dừng          |
| glm-5.2 10 reads         | glm-5.2 | ✅ Zero overhead                                    |

---

## Commit 3: `04059fdd9` — Aggressive thresholds + file-read summary + stronger messages

**Message:**

```
fix(windsurf): aggressive loop detection - warn=2, hard=3, freq=8/12
```

**Lessons từ production session `70405bff`:**

Session thực tế trên chainlens-research (swe-1.7 + Claude Code):

- `epics.md` đọc **4 lần** trước khi hard-stop trigger (waste 4 reads)
- `architecture.md` đọc **3 lần** trước warning
- **23 total Read calls** trước khi freq hard-stop trigger
- Model acknowledge "Do hạn chế Read-loop" và đổi sang Write+Bash → task hoàn thành

→ Thresholds quá cao, model waste quá nhiều reads trước khi bị ép dừng.

### 3.1 Lower thresholds

| Threshold             | Trước | Sau    |
| --------------------- | ----- | ------ |
| `LOOP_WARN_THRESHOLD` | 3     | **2**  |
| `LOOP_HARD_LIMIT`     | 4     | **3**  |
| `LOOP_TOOL_FREQ_WARN` | 12    | **8**  |
| `LOOP_TOOL_FREQ_HARD` | 18    | **12** |

### 3.2 Stronger warning messages với specific alternatives

**Warning (exact dup):**

```
[LOOP WARNING] You are repeating the same tool call (2x: read:read:a.ts).
You have ALREADY done this — do NOT call it again.
Use a DIFFERENT approach: if you need file content, use what you already read.
If you need to modify files, use Write/Edit/Bash instead of reading them again.
Proceed to your next step or produce your final answer.
```

**Hard-stop:**

```
[FORCED STOP] You have called the same tool 3 times with identical arguments (read:read:a.ts).
This is a loop — STOP calling tools immediately and produce your final answer.
If you need to modify files, use Write or Bash with a script instead of reading them again.
Summarize what you have accomplished so far.
```

**Frequency warning:**

```
[LOOP WARNING] You have called read 8 times in the last 20 calls.
This is excessive. Switch to a different tool or produce your final answer.
If you need to batch-modify files, use a single Bash script instead of multiple tool calls.
```

### 3.3 File-read summary injection

**Mới:** Khi loop detected, inject list files đã đọc (up to 15) để model biết đã đọc gì:

```typescript
const readFiles = new Set<string>();
// ... collect read file paths ...
let filesReadText = "";
if (readFiles.size > 0) {
  const fileList = [...readFiles]
    .slice(-15)
    .map((f) => `  - ${f}`)
    .join("\n");
  filesReadText = `\n\nFiles you have ALREADY READ (do NOT read them again):\n${fileList}`;
}
```

→ Model không re-read blindly, biết chính xác file nào đã xem.

### Test kết quả (commit 3)

Unit tests: **18/18 pass**

| #      | Case                              | Kết quả                          |
| ------ | --------------------------------- | -------------------------------- |
| A1     | 2x same read = warning            | ✅ `[LOOP WARNING] dup 2x`       |
| A2     | 3x same = hard stop               | ✅ `[FORCED STOP] same 3x`       |
| A3     | 1x = null                         | ✅ null                          |
| A4     | 8x read diff = freq warning       | ✅ `[LOOP WARNING] freq read 8x` |
| A5     | 7x read diff = null               | ✅ null                          |
| A6     | 12x read diff = hard stop         | ✅ `[FORCED STOP] read 12x`      |
| A7     | File-read summary included        | ✅ `Files ALREADY READ`          |
| A7b    | src/a.ts in summary               | ✅                               |
| A8     | Chunked reads diff ranges = null  | ✅ null                          |
| A9     | Mixed tools no dup = null         | ✅ null                          |
| A10    | Warning has "Write/Edit/Bash"     | ✅                               |
| A11    | Hard stop has "Bash script"       | ✅                               |
| A12    | Read (capital) tracked in summary | ✅ `src/config.ts`               |
| A13-14 | Empty / only user = null          | ✅ null                          |
| A15    | Parallel 2x = warning             | ✅ `[LOOP WARNING]`              |

E2E trên production (sau deploy `04059fdd9`):

| Test                     | Model   | Kết quả                                                       |
| ------------------------ | ------- | ------------------------------------------------------------- |
| 2x same read             | swe-1.7 | ✅ Model dừng (0 tool calls), summarize                       |
| 3x same read             | swe-1.7 | ✅ "I already read src/index.ts... will not repeat that read" |
| 6x diff reads            | glm-5.2 | ✅ Zero overhead                                              |
| Chunked reads (4 chunks) | swe-1.7 | ✅ No trigger, model trả Python generator                     |

---

## Full diff (3 commits gộp)

File: `open-sse/executors/windsurf.ts`
Lines added: ~245 (lines 632-867 + injection at 1234-1245)

### Phần 1: Constants + `stableToolCallKey` (lines 632-750)

```typescript
const LOOP_WARN_THRESHOLD = 2;
const LOOP_HARD_LIMIT = 3;
const LOOP_WINDOW_SIZE = 20;
const LOOP_TOOL_FREQ_WARN = 8;
const LOOP_TOOL_FREQ_HARD = 12;

function stableToolCallKey(name: string, argsJson: string): string {
  // ... bucketing logic per tool type ...
}
```

### Phần 2: `detectToolCallLoops` (lines 752-867)

```typescript
function detectToolCallLoops(messages: OpenAIMessage[]): string | null {
  // Collect tool_calls + track readFiles
  // Sliding window 20 calls
  // 1. Exact-duplicate detection (same key >= 2)
  // 2. Per-tool frequency detection (same name >= 8)
  // Build state summary + file-read summary
  // Return warning / hard-stop / null
}
```

### Phần 3: Injection point (lines 1234-1245)

```typescript
const loopWarning = detectToolCallLoops(rawMessages);
if (loopWarning) {
  wsMessages.push({ role: "user", content: loopWarning });
  log?.info?.("WS", `[WINDSURF_LOOP] ${loopWarning.substring(0, 120)}`);
}
```

---

## Production session 70405bff — Case study

**Session:** `70405bff-022d-49db-95cd-7b07a3edc5ac`
**Model:** `zai/swe-1.7` (via Claude Code, model=sonnet)
**Task:** Tạo epics + stories cho chainlens-research (Epic EMB + Epic 19-VND)

### Tool call statistics

| Metric              | Value                             |
| ------------------- | --------------------------------- |
| Total entries       | 223                               |
| Total tool calls    | 35 (Read: 23, Bash: 11, Write: 1) |
| Session state       | done                              |
| Story files created | 15 (EMB-0..6 + 19-VND-0a..6)      |
| epics.md patched    | ✅                                |
| Tokens used         | 78,608                            |

### Loop detection triggers

| Trigger                         | Khi nào                   | Model response                                                     |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `architecture.md` đọc 3x        | entries 36, 58, 68        | Model tiếp tục nhưng chậm dần                                      |
| `epics.md` đọc 4x → FORCED STOP | entries 38, 102, 146, 169 | **"Do hạn chế Read-loop, tôi sẽ ghi bằng Python script duy nhất"** |
| Read freq 23x → FORCED STOP     | sliding window            | Model đổi chiến thuật: Write + Bash                                |

### Model behavior sau loop detection

swe-1.7 **đã nghe lời** — thay vì tiếp tục Read loop:

1. Tạo Python script (`patch_stories.py`) chứa toàn bộ content
2. Write script ra file
3. Bash chạy script → tạo 15 story files + patch epics.md
4. Session kết thúc thành công

→ **Loop detection hoạt động đúng**: ép model đổi từ Read-loop sang Write+Bash one-shot.

---

## Thresholds evolution

| Version                | warn  | hard  | freq_warn | freq_hard | Lý do thay đổi                          |
| ---------------------- | ----- | ----- | --------- | --------- | --------------------------------------- |
| Commit 1 (`6e5922e07`) | 3     | 5     | —         | —         | Initial implementation                  |
| Commit 2 (`bbd5118ae`) | 3     | 4     | 12        | 18        | +chunked reads, +freq detection         |
| Commit 3 (`04059fdd9`) | **2** | **3** | **8**     | **12**    | Production session cho thấy 3/5 quá cao |

---

## Files modified

| File                             | Commits | Lines changed |
| -------------------------------- | ------- | ------------- |
| `open-sse/executors/windsurf.ts` | 3       | +245, -0      |

## Test files (tạm thời, trong /tmp)

| File                           | Mục đích                |
| ------------------------------ | ----------------------- |
| `/tmp/test-loop-detection.mjs` | Unit tests (commit 1)   |
| `/tmp/test-edge-cases.mjs`     | Unit tests (commit 2)   |
| `/tmp/test-adjusted.mjs`       | Unit tests (commit 3)   |
| `/tmp/test-complex-*.mjs`      | E2E tests (9 scenarios) |
| `/tmp/e2e-*.mjs`               | E2E production tests    |

---

## Key design decisions

1. **Không thay đổi role conversion** — `openAIMessagesToWs` vẫn convert tất cả sang USER. Loop detection là layer riêng, không phá core logic.

2. **Sliding window 20** — Đủ lớn để catch late loops, đủ nhỏ để không flag legitimate long sessions.

3. **Per-tool bucketing** — Mỗi tool type có bucketing logic riêng, tránh false positives:
   - `read`: path + line range (chunked reads OK)
   - `bash`: command prefix (cùng prefix = có thể loop)
   - `TaskCreate`: content prefix (cùng content = loop)
   - `write/edit`: full args (content-sensitive, mỗi edit khác nhau)

4. **File-read summary injection** — Model biết chính xác file nào đã đọc, không re-read blindly.

5. **Specific alternatives trong warning** — "Use Write/Edit/Bash" thay vì "do NOT call again" chung chung. Model biết đổi chiến thuật sang gì.

6. **Zero overhead cho non-looping models** — `detectToolCallLoops` return null khi không có duplicates, không inject gì cả.

---

## Deployment

Tất cả 3 commits pushed to `production` branch → Dokploy auto-rebuild → live trên `proxy.chainlens.net`.

| Commit | Hash        | Deployed |
| ------ | ----------- | -------- |
| 1      | `6e5922e07` | ✅       |
| 2      | `bbd5118ae` | ✅       |
| 3      | `04059fdd9` | ✅       |

Verify: E2E tests trên `proxy.chainlens.net` confirm code mới live (2x read trigger warning, 3x trigger hard-stop).
