// Regression guard for #4863: X-Route-Model header overrides body.model for routing.
// Also covers alignBodyModelWithRouting — without body alignment the post-guardrail
// path silently restores body.model and undoes the header (zai header + opencode body → 401).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  alignBodyModelWithRouting,
  resolveRoutingModel,
} from "../../src/sse/handlers/resolveRoutingModel.ts";

function req(headers: Record<string, string>) {
  return { headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } };
}

describe("resolveRoutingModel (#4863)", () => {
  it("uses body.model when no X-Route-Model header is present", () => {
    assert.equal(resolveRoutingModel(req({}), { model: "gpt-5.3-codex" }), "gpt-5.3-codex");
  });

  it("X-Route-Model header overrides body.model", () => {
    assert.equal(
      resolveRoutingModel(req({ "x-route-model": "my-combo" }), { model: "codex/gpt-5.3-codex" }),
      "my-combo"
    );
  });

  it("trims surrounding whitespace from the header value", () => {
    assert.equal(
      resolveRoutingModel(req({ "x-route-model": "  alias-x  " }), { model: "fallback" }),
      "alias-x"
    );
  });

  it("falls back to body.model when the header is empty/whitespace-only", () => {
    assert.equal(resolveRoutingModel(req({ "x-route-model": "   " }), { model: "fallback" }), "fallback");
  });

  it("detects subagent request via x-anthropic-billing-header and reroutes to default subagent model", () => {
    const result = resolveRoutingModel(
      req({ "x-anthropic-billing-header": "cc_version=1.0;cc_is_subagent=true" }),
      { model: "claude-opus-5" }
    );
    assert.equal(result, "claude-haiku-4.5");
  });

  it("detects subagent request via system prompt and reroutes to default subagent model", () => {
    const result = resolveRoutingModel(req({}), {
      model: "swe-1.7",
      system: "You are an agent for Claude Code, Anthropic's official CLI for Claude.",
    });
    assert.equal(result, "claude-haiku-4.5");
  });

  it("honors explicit X-Route-Model header even for subagent requests", () => {
    const result = resolveRoutingModel(
      req({ "x-is-subagent": "true", "x-route-model": "custom/override-model" }),
      { model: "claude-sonnet-5" }
    );
    assert.equal(result, "custom/override-model");
  });
});

describe("alignBodyModelWithRouting (X-Route-Model body lockstep)", () => {
  it("rewrites body.model when it differs from the routing model", () => {
    const body = { model: "opencode-zen/gpt-5.4", messages: [{ role: "user", content: "hi" }] };
    const routed = resolveRoutingModel(req({ "x-route-model": "zai/glm-5.2" }), body);
    const result = alignBodyModelWithRouting(body, routed);
    assert.equal(routed, "zai/glm-5.2");
    assert.equal(result.aligned, true);
    assert.equal(result.previousModel, "opencode-zen/gpt-5.4");
    assert.equal(result.body.model, "zai/glm-5.2");
    // Original body object is not mutated
    assert.equal(body.model, "opencode-zen/gpt-5.4");
  });

  it("is a no-op when body.model already matches", () => {
    const body = { model: "zai/glm-5.2" };
    const result = alignBodyModelWithRouting(body, "zai/glm-5.2");
    assert.equal(result.aligned, false);
    assert.equal(result.body, body);
  });

  it("is a no-op when routing model is empty", () => {
    const body = { model: "opencode-zen/gpt-5.4" };
    const result = alignBodyModelWithRouting(body, null);
    assert.equal(result.aligned, false);
    assert.equal(result.body.model, "opencode-zen/gpt-5.4");
  });
});
