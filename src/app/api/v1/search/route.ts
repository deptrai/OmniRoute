import { handleSearch } from "@omniroute/open-sse/handlers/search.ts";
import { getProviderCredentials, extractApiKey, isValidApiKey } from "@/sse/services/auth";
import {
  getAllSearchProviders,
  getSearchProvider,
  selectProvider,
  supportsSearchType,
  SEARCH_PROVIDERS,
  SEARCH_CREDENTIAL_FALLBACKS,
} from "@omniroute/open-sse/config/searchRegistry.ts";
import { errorResponse, unavailableResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import * as log from "@/sse/utils/logger";
import { toJsonErrorPayload } from "@/shared/utils/upstreamError";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { v1SearchSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { recordCost } from "@/domain/costRules";
import {
  computeCacheKey,
  getOrCoalesce,
  SEARCH_CACHE_DEFAULT_TTL_MS,
} from "@omniroute/open-sse/services/searchCache.ts";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
  type RateLimitedCredentials,
} from "@/app/api/v1/_shared/rateLimit";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

/**
 * GET /v1/search — list available search providers
 */
export async function GET() {
  const providers = getAllSearchProviders();
  const timestamp = Math.floor(Date.now() / 1000);

  const data = providers.map((p) => ({
    id: p.id,
    object: "search_provider",
    created: timestamp,
    name: p.name,
    search_types: p.searchTypes,
  }));

  return new Response(JSON.stringify({ object: "list", data }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

type SearchCredentials = Record<string, any>;
type SearchCredentialLookup = SearchCredentials | RateLimitedCredentials | null;

async function resolveSearchCredentials(providerId: string): Promise<SearchCredentialLookup> {
  const credentials = await getProviderCredentials(providerId).catch(() => null);
  if (credentials && !isSearchCredentialUnavailable(credentials)) return credentials;

  const fallbackId = SEARCH_CREDENTIAL_FALLBACKS[providerId];
  if (!fallbackId) return credentials;

  const fallbackCredentials = await getProviderCredentials(fallbackId).catch(() => null);
  if (fallbackCredentials && !isSearchCredentialUnavailable(fallbackCredentials)) {
    return fallbackCredentials;
  }

  return fallbackCredentials || credentials;
}

async function resolveSearchExecutionCredentials(providerConfig: {
  id: string;
  authType: string;
}): Promise<SearchCredentialLookup> {
  const credentials = await resolveSearchCredentials(providerConfig.id);
  if (credentials) return credentials;
  return providerConfig.authType === "none" ? {} : null;
}

// Helper: detect any credential sentinel that means "no usable account".
// Covers both `allRateLimited` and `allExpired` returns from getProviderCredentials.
function isSearchCredentialUnavailable(
  value: unknown
): value is { allRateLimited?: true; allExpired?: true } {
  return (
    !!value &&
    typeof value === "object" &&
    ((value as any).allRateLimited === true || (value as any).allExpired === true)
  );
}

// Helper: build domain filter array from filters object
function buildDomainFilter(filters?: {
  include_domains?: string[];
  exclude_domains?: string[];
}): string[] | undefined {
  if (!filters) return undefined;
  const parts: string[] = [];
  if (filters.include_domains?.length) parts.push(...filters.include_domains);
  if (filters.exclude_domains?.length) parts.push(...filters.exclude_domains.map((d) => `-${d}`));
  return parts.length > 0 ? parts : undefined;
}

/**
 * POST /v1/search — execute a web search
 */
async function postHandler(request: Request, context: unknown) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    log.warn("SEARCH", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const validation = validateBody(v1SearchSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, validation.error.message);
  }
  const body = validation.data;

  // Enforce API key policies — use "search" as model identifier for consistent policy config
  const policy = await enforceApiKeyPolicy(request, "search");
  if (policy.rejection) return policy.rejection;

  // Resolve provider and credentials
  if (body.provider) {
    const explicitProvider = getSearchProvider(body.provider);
    if (!explicitProvider) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown search provider: ${body.provider}`);
    }
    if (!supportsSearchType(explicitProvider, body.search_type)) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `Search provider ${body.provider} does not support search_type: ${body.search_type}`
      );
    }
  }

  let providerConfig = selectProvider(body.provider, body.search_type);
  if (!providerConfig) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      body.provider ? `Unknown search provider: ${body.provider}` : "No search providers available"
    );
  }

  let credentials: Record<string, any> | null = null;
  let alternateProviderId: string | undefined;
  let alternateCredentials: Record<string, any> | null = null;

  // Tracks the first unavailable (rate-limited or expired) provider seen in
  // auto-select, so we can return a meaningful error if no usable provider exists.
  let firstUnavailableCredentials: {
    providerId: string;
    credentials: any;
  } | null = null;

  if (body.provider) {
    // Explicit provider — single credential lookup (with fallback).
    // Even if all accounts are rate-limited, pass the credentials through
    // so handleSearch can fall back to an alternate provider.
    const explicitCredentials = await resolveSearchExecutionCredentials(providerConfig);
    credentials = explicitCredentials;
    if (!credentials) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `No credentials configured for search provider: ${providerConfig.id}. Add an API key for "${providerConfig.id}" in the dashboard.`
      );
    }

    // Find an alternate provider for explicit-provider failover, so if all
    // connections for the requested provider fail (e.g. all 3 SearXNG instances
    // are rate-limited) we can still fall back to another configured provider.
    const explicitOtherIds = Object.values(SEARCH_PROVIDERS)
      .filter(
        (provider) => !provider.fallbackOnly && supportsSearchType(provider, body.search_type)
      )
      .sort((a, b) => a.costPerQuery - b.costPerQuery)
      .map((p) => p.id)
      .filter((id) => id !== providerConfig.id);

    for (const pid of explicitOtherIds) {
      const altConfig = getSearchProvider(pid);
      const altCreds = altConfig ? await resolveSearchExecutionCredentials(altConfig) : null;
      if (isSearchCredentialUnavailable(altCreds)) continue;
      if (altCreds) {
        alternateProviderId = pid;
        alternateCredentials = altCreds;
        break;
      }
    }

    if (!alternateProviderId) {
      for (const provider of Object.values(SEARCH_PROVIDERS)) {
        if (!provider.fallbackOnly || provider.id === providerConfig.id) continue;
        if (!supportsSearchType(provider, body.search_type)) continue;
        const fallbackCreds = await resolveSearchExecutionCredentials(provider);
        if (fallbackCreds && !isSearchCredentialUnavailable(fallbackCreds)) {
          alternateProviderId = provider.id;
          alternateCredentials = fallbackCreds;
          break;
        }
      }
    }
  } else {
    // Auto-select — try the resolved provider first, then iterate others by cost
    const selectedCredentials = await resolveSearchExecutionCredentials(providerConfig);
    if (isSearchCredentialUnavailable(selectedCredentials)) {
      firstUnavailableCredentials = {
        providerId: providerConfig.id,
        credentials: selectedCredentials,
      };
    } else {
      credentials = selectedCredentials;
    }

    if (!credentials) {
      // Sort by cost to find cheapest with credentials (fallback-only providers
      // are reached via the last-resort step below, never the primary pick).
      const sortedIds = Object.values(SEARCH_PROVIDERS)
        .filter(
          (provider) => !provider.fallbackOnly && supportsSearchType(provider, body.search_type)
        )
        .sort((a, b) => a.costPerQuery - b.costPerQuery)
        .map((p) => p.id);

      for (const pid of sortedIds) {
        if (pid === providerConfig.id) continue;
        const altConfig = getSearchProvider(pid);
        const altCreds = altConfig ? await resolveSearchExecutionCredentials(altConfig) : null;
        if (isSearchCredentialUnavailable(altCreds)) {
          firstUnavailableCredentials ??= { providerId: pid, credentials: altCreds };
          continue;
        }
        if (altConfig && altCreds) {
          providerConfig = altConfig;
          credentials = altCreds;
          break;
        }
      }
    }

    if (!credentials) {
      if (firstUnavailableCredentials) {
        if (isAllRateLimitedCredentials(firstUnavailableCredentials.credentials)) {
          return rateLimitedProviderResponse(
            firstUnavailableCredentials.providerId,
            firstUnavailableCredentials.credentials
          );
        }
        return errorResponse(
          HTTP_STATUS.UNAUTHORIZED,
          `All ${firstUnavailableCredentials.providerId} accounts are expired or unavailable`
        );
      }
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `No credentials configured for any search provider. Add an API key for a search provider (${Object.keys(SEARCH_PROVIDERS).join(", ")}) in the dashboard.`
      );
    }

    // Find alternate for failover — must bind credentials to the matched provider.
    // Exclude fallback-only providers; they are only used by the last-resort step.
    const otherIds = Object.values(SEARCH_PROVIDERS)
      .filter(
        (provider) => !provider.fallbackOnly && supportsSearchType(provider, body.search_type)
      )
      .sort((a, b) => a.costPerQuery - b.costPerQuery)
      .map((p) => p.id)
      .filter((id) => id !== providerConfig.id);

    for (const pid of otherIds) {
      const altConfig = getSearchProvider(pid);
      const creds = altConfig ? await resolveSearchExecutionCredentials(altConfig) : null;
      if (isSearchCredentialUnavailable(creds)) continue;
      if (creds) {
        alternateProviderId = pid;
        alternateCredentials = creds;
        break;
      }
    }

    // Last-resort: guarantee a free no-key fallback (e.g. duckduckgo-free) as the
    // failover so out-of-the-box search still works when no credentialed provider
    // is configured. Only used when no real alternate was found above.
    if (!alternateProviderId) {
      for (const provider of Object.values(SEARCH_PROVIDERS)) {
        if (!provider.fallbackOnly || provider.id === providerConfig.id) continue;
        if (!supportsSearchType(provider, body.search_type)) continue;
        const fallbackCreds = await resolveSearchExecutionCredentials(provider);
        if (fallbackCreds && !isSearchCredentialUnavailable(fallbackCreds)) {
          alternateProviderId = provider.id;
          alternateCredentials = fallbackCreds;
          break;
        }
      }
    }
  }

  // Clamp max_results to provider limit
  const clampedMaxResults = Math.min(body.max_results, providerConfig.maxMaxResults);

  // Cache key — includes all fields that affect results, including the
  // pre-resolved alternate provider so a fallback result is not cached under
  // the primary provider's key.
  const cacheKey = computeCacheKey(
    body.query,
    providerConfig.id,
    body.search_type,
    clampedMaxResults,
    body.country,
    body.language,
    { filters: body.filters, offset: body.offset, time_range: body.time_range },
    alternateProviderId
  );

  const ttl = providerConfig.cacheTTLMs ?? SEARCH_CACHE_DEFAULT_TTL_MS;

  try {
    const { data: searchResult, cached } = await getOrCoalesce(cacheKey, ttl, async () => {
      const result = await handleSearch({
        query: body.query,
        provider: providerConfig.id,
        maxResults: clampedMaxResults,
        searchType: body.search_type,
        country: body.country,
        language: body.language,
        timeRange: body.time_range,
        offset: body.offset,
        domainFilter: buildDomainFilter(body.filters),
        contentOptions: body.content,
        strictFilters: body.strict_filters,
        providerOptions: body.provider_options,
        credentials,
        alternateProvider: alternateProviderId,
        alternateCredentials,
        log,
      });

      if (!result.success) {
        throw new SearchError(
          result.error || "Search failed",
          result.status || 502,
          result.retryAfter,
          result.retryAfterHuman
        );
      }

      return result.data!;
    });

    // Record cost for budget tracking (skip cache hits — no provider cost)
    if (!cached && policy.apiKeyInfo?.id && searchResult.usage?.search_cost_usd > 0) {
      try {
        recordCost(policy.apiKeyInfo.id, searchResult.usage.search_cost_usd);
      } catch (e: any) {
        log.warn("SEARCH", `Cost recording failed: ${e?.message}`);
      }
    }

    const response = {
      id: `search-${crypto.randomUUID()}`,
      ...searchResult,
      cached,
      usage: cached ? { queries_used: 0, search_cost_usd: 0 } : searchResult.usage,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (err: any) {
    if (err instanceof SearchError) {
      if (err.statusCode === HTTP_STATUS.RATE_LIMITED) {
        // Use the original error message (which already names the provider)
        // rather than forcing "All accounts rate limited", which may be wrong
        // for upstream 429s or alternate-provider rate limits.
        return unavailableResponse(
          err.statusCode,
          err.message,
          err.retryAfter,
          err.retryAfterHuman
        );
      }
      const errorPayload = toJsonErrorPayload(err.message, "Search provider error");
      return new Response(JSON.stringify(errorPayload), {
        status: err.statusCode,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    log.error("SEARCH", `Unexpected error: ${err.message}`);
    const errorPayload = toJsonErrorPayload(err.message, "Internal search error");
    return new Response(JSON.stringify(errorPayload), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
}

class SearchError extends Error {
  statusCode: number;
  retryAfter?: string | number | Date | null;
  retryAfterHuman?: string;
  constructor(
    message: string,
    statusCode: number,
    retryAfter?: string | number | Date | null,
    retryAfterHuman?: string
  ) {
    super(message);
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
    this.retryAfterHuman = retryAfterHuman;
  }
}

export const POST = withInjectionGuard(postHandler);
