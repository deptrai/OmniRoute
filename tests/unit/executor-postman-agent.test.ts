import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PostmanAgentExecutor } from "../../open-sse/executors/postman-agent.ts";
import { getExecutor } from "../../open-sse/executors/index.ts";

describe("PostmanAgentExecutor Contract", () => {
  it("resolves from getExecutor('postman-agent')", () => {
    const executor = getExecutor("postman-agent");
    assert.ok(executor);
    assert.strictEqual(typeof executor.execute, "function");
  });

  it("fails fast with 401 when apiKey/cookie is missing", async () => {
    const executor = new PostmanAgentExecutor();
    const res = await executor.execute({
      provider: "postman-agent",
      model: "claude-opus-4-8",
      body: {
        model: "postman/claude-opus-4-8",
        messages: [{ role: "user", content: "hello" }],
      },
      headers: {},
      credentials: { apiKey: "" },
    });

    assert.ok(res.response);
    assert.strictEqual(res.response.status, 401);
    const json = (await res.response.json()) as any;
    assert.match(json.error.message, /session cookie|postman\.sid/i);
  });

  it("fails fast with 400 when prompt and messages are empty", async () => {
    const executor = new PostmanAgentExecutor();
    const res = await executor.execute({
      provider: "postman-agent",
      model: "claude-opus-4-8",
      body: {
        model: "postman/claude-opus-4-8",
        messages: [],
      },
      headers: {},
      credentials: { apiKey: "postman.sid=test-valid-session" },
    });

    assert.ok(res.response);
    assert.strictEqual(res.response.status, 400);
    const json = (await res.response.json()) as any;
    assert.match(json.error.message, /No prompt or messages/i);
  });

  it("returns standard OpenAI wrapper shape", async () => {
    const executor = new PostmanAgentExecutor();
    const res = await executor.execute({
      provider: "postman-agent",
      model: "claude-opus-4-8",
      body: {
        model: "postman/claude-opus-4-8",
        messages: [{ role: "user", content: "hello" }],
      },
      headers: {},
      credentials: { apiKey: "" },
    });

    assert.ok(res.url);
    assert.ok(res.headers);
    assert.ok(res.transformedBody);
    assert.ok(res.response);
  });
});
