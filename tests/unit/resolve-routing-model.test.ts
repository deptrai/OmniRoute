// Regression guard for #4863: X-Route-Model header overrides body.model for routing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRoutingModel } from "../../src/sse/handlers/resolveRoutingModel.ts";

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
    assert.equal(
      resolveRoutingModel(req({ "x-route-model": "   " }), { model: "fallback" }),
      "fallback"
    );
  });

  it("detects subagent request via x-anthropic-billing-header and reroutes to default subagent model", () => {
    const result = resolveRoutingModel(
      req({ "x-anthropic-billing-header": "cc_version=1.0;cc_is_subagent=true" }),
      { model: "claude-opus-5" }
    );
    assert.equal(result, "claude-sonnet-5");
  });

  it("detects subagent request via system prompt and reroutes to default subagent model", () => {
    const result = resolveRoutingModel(req({}), {
      model: "swe-1.7",
      system: "You are an agent for Claude Code, Anthropic's official CLI for Claude.",
    });
    assert.equal(result, "claude-sonnet-5");
  });

  it("honors explicit X-Route-Model header even for subagent requests", () => {
    const result = resolveRoutingModel(
      req({ "x-is-subagent": "true", "x-route-model": "custom/override-model" }),
      { model: "claude-sonnet-5" }
    );
    assert.equal(result, "custom/override-model");
  });
});
