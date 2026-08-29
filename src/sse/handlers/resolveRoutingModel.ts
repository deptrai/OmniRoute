// Resolve the model used for routing. The `X-Route-Model` header, when present,
// overrides `body.model` — letting a caller/proxy force a specific combo/alias/model
// regardless of what the client CLI sent. This is useful when a CLI hardcodes
// `body.model` to a fixed provider/model (bypassing combo routing): an upstream
// proxy can send `X-Route-Model` to restore routing control without mutating the
// request body. The resolved value still flows through `enforceApiKeyPolicy`, so
// it cannot bypass per-key model/combo allowlists. See PR #4863.

type HeaderCarrier = { headers: { get(name: string): string | null } };

export const DEFAULT_SUBAGENT_MODEL = "claude-sonnet-5";

/**
 * Detect whether the incoming request is issued by an autonomous subagent
 * (such as Claude Code CLI's spawned subagent, agent delegation, etc.).
 */
export function isSubagentRequest(
  request?: HeaderCarrier | null,
  body?: { model?: string | null; system?: unknown; messages?: unknown } | null
): boolean {
  if (!request && !body) return false;

  // 1. Check HTTP headers
  const billingHeader = request?.headers?.get?.("x-anthropic-billing-header") || "";
  if (billingHeader.includes("cc_is_subagent=true")) return true;
  if (
    request?.headers?.get?.("x-is-subagent") === "true" ||
    request?.headers?.get?.("x-subagent") === "true"
  ) {
    return true;
  }

  // 2. Check body.system (string or array of text blocks)
  const system = body?.system;
  let systemText = "";
  if (typeof system === "string") {
    systemText = system;
  } else if (Array.isArray(system)) {
    systemText = system
      .map((block: any) => (typeof block === "string" ? block : block?.text || ""))
      .join("\n");
  }

  // 3. Scan messages for system or developer roles
  if (Array.isArray(body?.messages)) {
    const sysTexts = (body.messages as any[])
      .filter((m) => m?.role === "system" || m?.role === "developer")
      .map((m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "")));
    if (sysTexts.length > 0) {
      systemText += (systemText ? "\n" : "") + sysTexts.join("\n");
    }
  }

  if (systemText.includes("cc_is_subagent=true")) return true;
  if (
    systemText.includes("Messages from the agent that launched you") &&
    systemText.includes("direct your work")
  ) {
    return true;
  }
  if (
    systemText.includes("You are a Claude agent, built on Anthropic's Claude Agent SDK") ||
    systemText.includes("You are an agent for Claude Code, Anthropic's official CLI for Claude")
  ) {
    return true;
  }

  return false;
}

/**
 * Resolve the routing model for subagent requests.
 * When a subagent is detected, route to the default subagent model
 * (antigravity/gemini-3.7-flash or SUBAGENT_DEFAULT_MODEL).
 */
export function resolveSubagentRoutingModel(
  requestedModel: string | null | undefined,
  isSubagent: boolean
): string | null | undefined {
  if (!isSubagent || !requestedModel) return requestedModel;

  const targetModel = process.env.SUBAGENT_DEFAULT_MODEL || DEFAULT_SUBAGENT_MODEL;
  return targetModel;
}

export function resolveRoutingModel(
  request: HeaderCarrier,
  body: { model?: string | null; system?: unknown; messages?: unknown }
): string | null | undefined {
  const headerModel = request?.headers?.get?.("x-route-model")?.trim();
  if (headerModel) return headerModel;

  const baseModel = body?.model;
  const isSubagent = isSubagentRequest(request, body);
  if (isSubagent) {
    return resolveSubagentRoutingModel(baseModel, true);
  }

  return baseModel;
}
