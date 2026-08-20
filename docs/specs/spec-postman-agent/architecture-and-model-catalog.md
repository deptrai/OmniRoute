# Postman Agent Provider: Architecture & Model Catalog

## 1. Supported Model Matrix

| Model ID            | Public Display Name | Reasoning | Vision | Context Window | Max Output | Upstream Engine         |
| :------------------ | :------------------ | :-------: | :----: | :------------: | :--------: | :---------------------- |
| `claude-opus-4-8`   | Claude Opus 4.8     |    ✅     |   ✅   |    200,000     |  128,000   | Anthropic Claude Opus   |
| `claude-sonnet-4-6` | Claude Sonnet 4.6   |    ✅     |   ✅   |    200,000     |   64,000   | Anthropic Claude Sonnet |
| `gpt-5.5`           | GPT-5.5             |    ✅     |   ✅   |   1,050,000    |  128,000   | OpenAI GPT-5.5          |
| `gpt-5.6-sol`       | GPT-5.6 Sol         |    ✅     |   ✅   |   1,050,000    |  128,000   | OpenAI GPT-5.6 Sol      |
| `gpt-5.6-terra`     | GPT-5.6 Terra       |    ✅     |   ✅   |   1,050,000    |  128,000   | OpenAI GPT-5.6 Terra    |
| `gpt-5.6-luna`      | GPT-5.6 Luna        |    ✅     |   ✅   |   1,050,000    |  128,000   | OpenAI GPT-5.6 Luna     |
| `gpt-5.4`           | GPT-5.4             |    ✅     |   ✅   |   1,050,000    |  128,000   | OpenAI GPT-5.4          |
| `thinking`          | Thinking (Extended) |    ✅     |   ❌   |    200,000     |   64,000   | Hybrid Reasoning        |
| `auto`              | Auto (Optimized)    |    ❌     |   ❌   |    200,000     |   64,000   | Dynamic Router          |

---

## 2. Component Architecture

```
[Client (Playground / Cursor / ChainLens)]
                   │
                   ▼  (POST /v1/chat/completions)
        [OmniRoute Core Gateway]
                   │
                   ▼  (executor = "postman-agent")
         [PostmanAgentExecutor]
                   │  - Formats multi-turn dialog
                   │  - Injects tool schemas
                   │  - Normalizes cookies (postman.sid)
                   ▼
         [PostmanSession Manager]
                   │  - Singleton Headless Chromium (Playwright)
                   │  - Serialized Mutex RequestQueue
                   │  - execCommand("insertText") 0ms paste
                   │  - Dynamic Model Dropdown Switcher
                   │  - 3.2s Debounced DOM Stream Observer
                   ▼
     [Postman Web Workspace Agent Mode]
     (https://<team>.postman.co/workspace/<id>/configure-mcp-servers?sideView=agentMode)
```

---

## 3. DOM Selectors & Wire Conventions

- **Editor Selector:** `[contenteditable="true"]` inside `.ai-chat-input-editor-container`.
- **Model Button Selector:** `button` containing `"Claude" | "GPT-" | "Thinking" | "Auto"`.
- **Submit Button:** `button` immediately following active model button or last button in the input container.
- **Agent Output Selector:** `.ai-chat-agent-message`.
- **Stabilization Condition:** `messages[messages.length - 1]` length unchanged for `stableTicks >= 3` (interval 800ms = 2.4s-3.2s).
