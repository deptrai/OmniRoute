---
id: SPEC-omniroute-postman-agent
companions:
  - architecture-and-model-catalog.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for the Postman Agent Web/Cookie Provider in OmniRoute.

# OmniRoute Postman Agent Provider (Claude Opus 4.8 / Enterprise)

## Why

OmniRoute aims to unify all enterprise and consumer AI model access under a standard OpenAI-compatible gateway (`/v1/chat/completions`). Postman Enterprise offers Agent Mode with state-of-the-art models (including `Claude Opus 4.8`, `Claude Sonnet 4.6`, `GPT-5.5`, `GPT-5.6 Sol`, `GPT-5.6 Terra`, `GPT-5.6 Luna`, `Thinking`) through web session cookies (`postman.sid`).

Without this provider, developers must use manual Postman web UI or pay high direct API fees. This feature integrates Postman Agent Mode as a first-class web-cookie provider within OmniRoute, automating the headless browser session, multi-turn conversation formatting, dynamic model selection, and OpenAI SSE streaming.

## Capabilities

- **CAP-1**
  - **intent:** OmniRoute registers `postman-agent` and alias `postman` in the provider catalog, supporting Claude Opus 4.8, Claude Sonnet 4.6, GPT-5.5, GPT-5.6 (Sol/Terra/Luna), Thinking, and Auto models.
  - **success:** `GET /v1/models` returns all 9 Postman models with proper prefixing (`postman/claude-opus-4-8`, `postman/gpt-5.6-sol`, etc.); UI shows Postman in the Web Cookie provider grid with `subscriptionRisk` flags.

- **CAP-2**
  - **intent:** OmniRoute manages a persistent, headless Chromium session via Playwright that injects user session cookies (`postman.sid`) across `.postman.co`, `.postman.com`, and `identity.getpostman.com`.
  - **success:** The session boots in background, navigates to the Agent Mode workspace URL with `domcontentloaded`, and automatically recovers from disconnections or server restarts via `SIGINT`/`SIGTERM` hooks.

- **CAP-3**
  - **intent:** OmniRoute automatically switches to the requested model in the Postman UI dropdown prior to submitting the prompt.
  - **success:** When a request targets `postman/gpt-5.6-sol` or `postman/claude-opus-4-8`, the executor clicks the active model dropdown and selects the exact model before dispatching the user prompt.

- **CAP-4**
  - **intent:** OmniRoute accepts standard OpenAI multi-turn messages and optional tool definitions, formatting them into a structured dialog transcript and injecting it instantly without typing delay or premature newline submission.
  - **success:** Rich text editor is cleared and populated via `document.execCommand("insertText")`; multi-turn dialogue retains past user/assistant context; multiline code blocks do not trigger early Enter submit; tool schemas are embedded into prompt context.

- **CAP-5**
  - **intent:** OmniRoute emits OpenAI-compatible JSON completions for non-streaming calls and SSE `chat.completion.chunk` streams with `[DONE]` for streaming calls, preserving indentation and code formatting.
  - **success:** Non-streaming responses return HTTP 200 with standard `choices[0].message.content`; streaming responses emit text deltas without stripping tabs/newlines; errors return standard 401/502/504 JSON error objects.

## Constraints

- **Single Input Serialization:** The Postman web chat editor operates as a single DOM input; concurrent requests must be serialized via a Promise mutex (`requestQueue`) to prevent overlapping text entry.
- **Stabilization Polling:** Streaming response detection must observe at least 3-4 consecutive polling cycles (3.2s) of unchanged text before finalizing to accommodate model reasoning pauses.
- **Cookie Security:** Raw cookie strings or bare session IDs must be normalized to `postman.sid=<value>` and stripped of extraneous quotes.
- **Conformance with BaseExecutor:** The executor must return `{ response: Response, url: string, headers: Record<string, string>, transformedBody: any }` to maintain compatibility with `open-sse/handlers/chatCore.ts`.

## Non-goals

- This provider does not bypass Postman's own account-level rate limits or credit quotas (~800 AI credits/month).
- It does not expose Postman collection runner or API testing tools directly; only the interactive AI Chat Agent interface.
- It does not support native multi-tab concurrency within the same browser instance in v1 (single-page serialized queue).

## Success Signal

- `npm run typecheck:core` passes with exit code 0.
- All unit tests in `open-sse/executors/__tests__/executor-postman-agent.test.ts` pass (5/5).
- Live API calls to `http://localhost:20128/v1/chat/completions` succeed with:
  - Non-streaming math calculation (`25 * 25 = 625`).
  - Streaming Vietnamese poem generation.
  - Multi-turn conversation context recall.
  - Model switching to `postman/gpt-5.6-sol` and `postman/gpt-5.6-terra`.
  - Tool schema recognition and JSON invocation.

## Assumptions

- The user possesses a valid Postman account with Enterprise Trial or AI Agent access enabled.
- The default workspace `https://epsiloncryptoai-7880991.postman.co/workspace/280d1867-5a3e-41c7-8465-9e4b0edf866f/configure-mcp-servers?sideView=agentMode` serves as the primary endpoint unless custom `teamDomain` / `workspaceId` are provided in `providerSpecificData`.
- Postman maintains DOM element `.ai-chat-agent-message` and `[contenteditable="true"]` for chat interaction.

## Open Questions

- Should OmniRoute v2 implement a multi-page / multi-context pool (e.g. 3-5 concurrent Chromium tabs) to handle high concurrent load?
- Should OmniRoute auto-fetch available workspace IDs dynamically via Postman internal API (`https://api.getpostman.com/workspaces`) if none are configured?

## Review Findings

- [x] [Review][Patch] Fix Promise Mutex Queue exception handling to prevent permanent deadlock [open-sse/executors/postman-session.ts:211-221]
- [x] [Review][Patch] Remove hardcoded private teamDomain/workspaceId fallback and support generic workspace URLs [open-sse/executors/postman-agent.ts:50-56]
- [x] [Review][Patch] Add process SIGINT/SIGTERM lifecycle cleanup hooks for Chromium [open-sse/executors/postman-session.ts:66-71]
- [x] [Review][Patch] Use Unicode code-point safe chunking to prevent surrogate pair/emoji corruption in SSE streaming [open-sse/executors/postman-agent.ts:117-145]
- [x] [Review][Patch] Strengthen model prefix stripping regex to handle case-insensitivity [open-sse/executors/postman-agent.ts:42-45]
- [x] [Review][Patch] Ensure debounce/stabilization polling waits at least 3.2s for deep reasoning models [open-sse/executors/postman-session.ts:276-282]
- [x] [Review][Patch] Update unit tests to align with credentials contract and exact error messages [tests/unit/executor-postman-agent.test.ts:1-71]
