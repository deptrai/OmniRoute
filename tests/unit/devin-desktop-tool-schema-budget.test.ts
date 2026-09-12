/**
 * Regression test for the Devin Desktop empty-Agent-args incident (2026-09-12).
 *
 * `convertTools` packs tool definitions into a fixed-size budget. When the
 * budget is nearly exhausted, non-critical tools are sent upstream with a
 * degraded schema — `{"type":"object"}` or `{}`. Claude Code sessions load
 * 250+ tools (critical builtins + hundreds of MCP tools), so the Agent tool —
 * previously in the last-priority "other" group — arrived upstream with `{}`.
 * The model then emitted `Agent` calls with NO arguments, and downstream
 * schema repair fabricated {"description":"","prompt":""}, spawning agents
 * with empty prompts.
 *
 * The fix: Agent and the task/subagent-management family are critical builtins
 * and must keep their full input_schema even under budget pressure.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { convertTools } = await import("../../open-sse/executors/devin-desktop.ts");

const AGENT_SCHEMA = {
  type: "object",
  required: ["description", "prompt"],
  properties: {
    description: { type: "string", description: "A short (3-5 word) description of the task" },
    prompt: { type: "string", description: "The task for the agent to perform" },
    subagent_type: { type: "string" },
    model: { type: "string" },
  },
};

function makeTool(name, descLen = 400, schemaProps = 6) {
  const properties = {};
  for (let i = 0; i < schemaProps; i++) {
    properties[`param_${i}`] = { type: "string", description: `param ${i}` };
  }
  return {
    type: "function",
    function: {
      name,
      description: `${name} tool. ${"x".repeat(descLen)}`,
      parameters: { type: "object", properties, required: ["param_0"] },
    },
  };
}

test("Agent keeps its full input_schema even when the tools budget is nearly exhausted", () => {
  // Mirror the incident shape: critical builtins + ~220 MCP tools + Agent.
  const tools = [];
  for (const n of ["Write", "Edit", "Read", "Bash", "Grep", "Glob", "Skill"]) {
    tools.push(makeTool(n, 500, 10));
  }
  for (let i = 0; i < 220; i++) {
    tools.push(makeTool(`mcp__server_${i}__tool_${i}`, 300, 5));
  }
  tools.push({
    type: "function",
    function: { name: "Agent", description: "Launch a new agent", parameters: AGENT_SCHEMA },
  });
  tools.push(makeTool("AskUserQuestion", 200, 3));

  const out = convertTools(tools);
  const agent = out.find((t) => t.name === "Agent");

  assert.ok(agent, "Agent tool must be present in the converted tools");
  const schema = JSON.parse(agent.jsonSchemaString);
  assert.ok(
    schema.properties && "description" in schema.properties && "prompt" in schema.properties,
    `Agent must retain its full input_schema under budget pressure, got: ${agent.jsonSchemaString}`
  );
  assert.deepEqual(schema.required, ["description", "prompt"]);
});

test("critical builtins keep full schemas; non-critical tools may still degrade", () => {
  const tools = [];
  for (let i = 0; i < 260; i++) {
    tools.push(makeTool(`mcp__big_${i}__t`, 400, 8));
  }
  tools.push(makeTool("Bash", 300, 4));
  tools.push(makeTool("SomeRandomTool", 300, 4));

  const out = convertTools(tools);
  const bash = out.find((t) => t.name === "Bash");
  assert.ok(bash, "Bash (critical builtin) must be present");
  const bashSchema = JSON.parse(bash.jsonSchemaString);
  assert.ok(
    bashSchema.properties && Object.keys(bashSchema.properties).length > 0,
    "critical builtin keeps a populated schema"
  );
});
