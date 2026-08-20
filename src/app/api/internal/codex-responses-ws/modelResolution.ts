/**
 * Model resolution for the Codex Responses-over-WebSocket bridge.
 *
 * The bridge is codex-only, but the OpenAI Codex CLI rejects provider-prefixed
 * model ids (e.g. "codex/gpt-5.5") client-side when `supports_websockets` is
 * enabled — it only accepts bare ChatGPT model ids (e.g. "gpt-5.5"). Those bare
 * ids can resolve to a different default provider (openai / openrouter) under
 * OmniRoute's global model routing, which the bridge would then reject with
 * `codex_ws_provider_required` (or fail the credentials lookup).
 *
 * Since this endpoint only ever talks to the Codex upstream, re-resolve a bare
 * id under the `codex/` prefix so it is treated as codex. Provider-prefixed ids
 * (already containing a "/") are left untouched.
 *
 * See docs/reference/API_REFERENCE.md → "Responses over WebSocket (Codex)".
 */

export interface ResolvedModelInfo {
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

export type ModelResolver = (modelStr: string) => Promise<ResolvedModelInfo>;

/**
 * Resolve a Responses-WebSocket model id, preferring the codex provider.
 *
 * @param requestedModel the bare/prefixed model id sent by the client
 * @param resolve a `getModelInfo`-style resolver
 * @returns the codex-preferred resolution, or the original resolution if the
 *          model genuinely does not map to codex.
 */
export async function resolveCodexWsModelInfo(
  requestedModel: string,
  resolve: ModelResolver
): Promise<ResolvedModelInfo> {
  const info = await resolve(requestedModel);

  // Already codex, or explicitly provider-prefixed → respect it.
  if (info?.provider === "codex" || requestedModel.includes("/")) {
    return info;
  }

  // Bare id resolved to a non-codex provider; retry as a codex model.
  const codexInfo = await resolve(`codex/${requestedModel}`);
  return codexInfo?.provider === "codex" ? codexInfo : info;
}

import { getProviderConnections } from "@/lib/localDb";

async function isProviderActive(providerId: string): Promise<boolean> {
  try {
    const conns = (await getProviderConnections()) as Array<{
      provider?: string;
      isActive?: unknown;
      is_active?: unknown;
    }>;
    if (!Array.isArray(conns)) return false;
    return conns.some((c) => {
      const active =
        c.isActive !== false && c.isActive !== 0 && c.is_active !== false && c.is_active !== 0;
      if (!active) return false;
      if (c.provider === providerId) return true;
      if (providerId === "postman" && (c.provider === "postman" || c.provider === "postman-agent"))
        return true;
      if (providerId === "codex" && (c.provider === "codex" || c.provider === "cx")) return true;
      return false;
    });
  } catch {
    return false;
  }
}

/**
 * Resolve a model ID for the HTTP Responses path, applying codex/postman preference
 * for bare ChatGPT-style model IDs (those without a provider prefix) or cx/ prefixed IDs.
 *
 * When the Codex CLI falls back from WebSocket to HTTP (#15492), it sends bare
 * model IDs like "gpt-5.5" to /v1/responses. Without this resolution, OmniRoute
 * routes them to openrouter/openai instead of the configured codex/postman
 * connections.
 *
 * @param requestedModel the model id from the Responses API request body
 * @param resolve a getModelInfo-style resolver
 * @param isCombo optional predicate — when the bare id is a combo name, skip the codex
 *        rewrite so downstream combo routing resolves it (#3227/#3233).
 * @returns { model, changed } — model is the (possibly rewritten) id;
 *          changed=true means a provider/ prefix was applied.
 */
export async function resolveResponsesApiModel(
  requestedModel: string,
  resolve: ModelResolver,
  isCombo?: (name: string) => Promise<boolean> | boolean
): Promise<{ model: string; changed: boolean }> {
  if (!requestedModel) {
    return { model: requestedModel, changed: false };
  }

  const isCodexPrefixed = /^(cx|codex)\//i.test(requestedModel);
  const isPostmanPrefixed = /^(postman|postman-agent)\//i.test(requestedModel);

  if (isPostmanPrefixed) {
    return { model: requestedModel, changed: false };
  }

  if (requestedModel.includes("/") && !isCodexPrefixed) {
    return { model: requestedModel, changed: false };
  }

  // #3509: "auto" is OmniRoute's zero-config auto-routing keyword
  if (requestedModel === "auto") {
    const codexActive = await isProviderActive("codex");
    const postmanActive = await isProviderActive("postman");
    if (!codexActive && postmanActive) {
      return { model: "postman/auto", changed: true };
    }
    return { model: requestedModel, changed: false };
  }

  // #3227/#3233: a bare combo name must NOT be force-prefixed
  if (isCombo) {
    try {
      if (await isCombo(requestedModel)) return { model: requestedModel, changed: false };
    } catch {
      // combo lookup unavailable — fall through to normal resolution
    }
  }

  try {
    const rawModel = isCodexPrefixed
      ? requestedModel.replace(/^(cx|codex)\//i, "")
      : requestedModel;
    const codexActive = await isProviderActive("codex");
    const postmanActive = await isProviderActive("postman");

    // If codex is NOT active but postman IS active, auto-route to postman
    if (!codexActive && postmanActive) {
      return { model: `postman/${rawModel}`, changed: true };
    }

    const resolved = await resolveCodexWsModelInfo(rawModel, resolve);
    if (resolved?.provider !== "codex") {
      return { model: requestedModel, changed: false };
    }

    const prefixed = `codex/${resolved.model || rawModel}`;
    return { model: prefixed, changed: true };
  } catch {
    return { model: requestedModel, changed: false };
  }
}
