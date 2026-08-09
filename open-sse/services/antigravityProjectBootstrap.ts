/**
 * Antigravity project bootstrap — loadCodeAssist + onboardUser.
 *
 * The Google Cloud Code Assist API (/v1internal:models) requires a prior
 * /v1internal:loadCodeAssist call to assign a project context to the
 * OAuth token. Without this bootstrap, :models returns 404.
 *
 * This module provides an idempotent ensureAntigravityProjectAssigned()
 * helper that is called once per access-token before every discovery
 * attempt. Results are memoized per-token for the process lifetime to
 * avoid redundant round-trips.
 *
 * When loadCodeAssist returns no project (account never onboarded),
 * the fallback calls onboardUser to create the project, then retries.
 */

import {
  getAntigravityHeaders,
  getAntigravityLoadCodeAssistMetadata,
} from "./antigravityHeaders.ts";
import { getAntigravityBootstrapHeaders } from "./antigravityClientProfile.ts";
import { extractCodeAssistOnboardTierId } from "./codeAssistSubscription.ts";
import {
  getAntigravityOnboardUrls,
  getAntigravityLoadCodeAssistUrls,
} from "../config/antigravityUpstream.ts";
import type { AntigravityClientProfile } from "./antigravityClientProfile.ts";

const BOOTSTRAP_TIMEOUT_MS = 8_000;
const ONBOARD_TIMEOUT_MS = 15_000;
const DEFAULT_TIER_ID = "legacy-tier";

/** Max entries in the per-token caches (prevents unbounded growth). */
const MAX_CACHE_SIZE = 256;

/** LRU-style Map: deleting and re-inserting moves the key to the end. */
function evictOldest(cache: Map<string, unknown>): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Per-token memoization cache (lives for the process lifetime). */
const projectCache = new Map<string, string>();

/** Per-key lock to prevent concurrent onboard attempts for the same token. */
const onboardLocks = new Map<string, Promise<boolean>>();

/** Per-token memoization for accounts we already tried onboarding. */
const onboardAttemptedCache = new Set<string>();

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function getProjectCacheKey(accessToken: string, clientProfile: AntigravityClientProfile): string {
  return `${clientProfile}:${accessToken}`;
}

type AntigravityAllowedTier = {
  id?: string;
  isDefault?: boolean;
  userDefinedCloudaicompanionProject?: boolean;
  name?: string;
};

type LoadCodeAssistResult = {
  projectId: string | null;
  tierId: string;
  allowedTiers: AntigravityAllowedTier[];
  raw: Record<string, unknown>;
};

function getAntigravityBootstrapHeadersForProfile(
  clientProfile: AntigravityClientProfile,
  accessToken?: string | null
): Record<string, string> {
  if (clientProfile === "harness") {
    return getAntigravityBootstrapHeaders(clientProfile, accessToken);
  }
  return getAntigravityHeaders("loadCodeAssist", accessToken);
}

/**
 * Attempt loadCodeAssist against each known base URL in order.
 * Returns the discovered project id and tier id, or null projectId if all endpoints fail.
 */
async function tryLoadCodeAssist(
  accessToken: string,
  fetchImpl: FetchLike,
  clientProfile: AntigravityClientProfile
): Promise<LoadCodeAssistResult> {
  const urls = getAntigravityLoadCodeAssistUrls();
  const headers = getAntigravityBootstrapHeadersForProfile(clientProfile, accessToken);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata: getAntigravityLoadCodeAssistMetadata() }),
        signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
      });

      if (!response.ok) {
        console.warn(
          `[models] antigravity loadCodeAssist failed at ${url} (${response.status}) — trying next`
        );
        continue;
      }

      const data = (await response.json()) as Record<string, unknown>;

      // cloudaicompanionProject may be a plain string or an object with an id field.
      const raw = data.cloudaicompanionProject;
      const projectId =
        typeof raw === "string"
          ? raw.trim()
          : raw &&
              typeof raw === "object" &&
              typeof (raw as Record<string, unknown>).id === "string"
            ? ((raw as Record<string, unknown>).id as string).trim()
            : "";

      const tierId = extractCodeAssistOnboardTierId(data) || DEFAULT_TIER_ID;
      const allowedTiers = Array.isArray(data.allowedTiers)
        ? (data.allowedTiers as AntigravityAllowedTier[])
        : [];

      if (projectId) {
        return { projectId, tierId, allowedTiers, raw: data };
      }

      // Continue to next URL if available — a different endpoint might
      // have the project. Only return empty when this is the last URL.
      if (i === urls.length - 1) {
        return { projectId: null, tierId, allowedTiers, raw: data };
      }
      console.warn(
        `[models] antigravity loadCodeAssist at ${url} returned no project id — trying next`
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[models] antigravity loadCodeAssist threw for ${url}: ${msg} — trying next`);
    }
  }
  return { projectId: null, tierId: DEFAULT_TIER_ID, allowedTiers: [], raw: {} };
}

/**
 * Choose an onboardable tier from loadCodeAssist's allowedTiers list.
 * Prefer the server-marked default that does NOT require the user to supply
 * their own Google Cloud project (userDefinedCloudaicompanionProject = false).
 * Server-managed tiers like "free-tier" can be onboarded without a project;
 * "standard-tier" and other user-defined tiers need an existing project and
 * must be skipped here.
 */
function pickOnboardTier(allowedTiers: AntigravityAllowedTier[]): AntigravityAllowedTier | null {
  if (!allowedTiers.length) return null;

  const isManaged = (t?: AntigravityAllowedTier) =>
    t?.id && t.userDefinedCloudaicompanionProject !== true;

  const defaultManaged = allowedTiers.find((t) => t.isDefault && isManaged(t));
  if (defaultManaged) return defaultManaged;

  const anyManaged = allowedTiers.find(isManaged);
  if (anyManaged) return anyManaged;

  return null;
}

/**
 * Attempt onboardUser to create a Cloud Code project for the account.
 * Called when loadCodeAssist returns no project — the account has never
 * been onboarded. Returns true if any endpoint reports success.
 *
 * The request body follows the Code Assist wire format:
 *   { tierId, metadata, cloudaicompanionProject? }
 * `tierId` is camelCase (not tier_id). For user-defined tiers a project id
 * must also be supplied; this function only onboards managed tiers.
 */
async function tryOnboardUser(
  accessToken: string,
  fetchImpl: FetchLike,
  clientProfile: AntigravityClientProfile,
  tier: AntigravityAllowedTier
): Promise<boolean> {
  const urls = getAntigravityOnboardUrls();
  const headers = getAntigravityBootstrapHeadersForProfile(clientProfile, accessToken);

  for (const url of urls) {
    try {
      const onboardBody: Record<string, unknown> = {
        tierId: tier.id,
        metadata: getAntigravityLoadCodeAssistMetadata(),
      };

      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(onboardBody),
        signal: AbortSignal.timeout(ONBOARD_TIMEOUT_MS),
      });

      if (response.ok) {
        return true;
      }

      const body = await response.text().catch(() => "");
      console.warn(
        `[models] antigravity onboardUser failed at ${url} (${response.status}) — trying next (tier=${tier.id}): ${body.slice(0, 200)}`
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[models] antigravity onboardUser threw for ${url}: ${msg} — trying next`);
    }
  }
  return false;
}

function addToOnboardAttemptedCache(key: string): void {
  if (onboardAttemptedCache.size >= MAX_CACHE_SIZE) {
    const oldest = onboardAttemptedCache.values().next().value;
    if (oldest !== undefined) onboardAttemptedCache.delete(oldest);
  }
  onboardAttemptedCache.add(key);
}

/**
 * Ensure a project is assigned to the given access token by calling
 * loadCodeAssist if not already cached. Idempotent — repeated calls
 * for the same token return the cached result without a network round-trip.
 *
 * Failures are non-fatal: the caller should proceed with the :models
 * request regardless (the stored project_id in the DB may still be valid).
 *
 * @param accessToken  The OAuth bearer token for the current connection.
 * @param fetchImpl    Injected fetch implementation (defaults to globalThis.fetch).
 * @param clientProfile Client identity to present to the bootstrap endpoints.
 */
export async function ensureAntigravityProjectAssigned(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
  clientProfile: AntigravityClientProfile = "ide"
): Promise<string | undefined> {
  const cacheKey = getProjectCacheKey(accessToken, clientProfile);
  if (projectCache.has(cacheKey)) {
    const cached = projectCache.get(cacheKey)!;
    // Touch on read: delete+reinsert moves this entry to the end (LRU).
    projectCache.delete(cacheKey);
    projectCache.set(cacheKey, cached);
    return cached;
  }

  const { projectId: initialProjectId, allowedTiers } = await tryLoadCodeAssist(
    accessToken,
    fetchImpl,
    clientProfile
  );

  let projectId = initialProjectId;

  // loadCodeAssist is read-only — if the account was never onboarded, it returns
  // empty. Pick a server-managed tier from allowedTiers and call onboardUser to
  // provision a project, then retry discovery.
  if (!projectId && !onboardAttemptedCache.has(cacheKey)) {
    const onboardTier = pickOnboardTier(allowedTiers);

    // Per-key lock: concurrent calls for the same token share one onboard attempt.
    let lock = onboardLocks.get(cacheKey);
    if (!lock && onboardTier) {
      lock = (async () => {
        try {
          const onboarded = await tryOnboardUser(
            accessToken,
            fetchImpl,
            clientProfile,
            onboardTier
          );
          if (onboarded) {
            const retry = await tryLoadCodeAssist(accessToken, fetchImpl, clientProfile);
            if (retry.projectId) {
              evictOldest(projectCache);
              projectCache.set(cacheKey, retry.projectId);
              return true;
            }
          }
          return false;
        } catch {
          return false;
        } finally {
          onboardLocks.delete(cacheKey);
          addToOnboardAttemptedCache(cacheKey);
        }
      })();
      onboardLocks.set(cacheKey, lock);
    }
    const success = lock ? await lock : false;
    if (success) {
      const cached = projectCache.get(cacheKey);
      if (cached) return cached;
    }
  }

  if (projectId) {
    evictOldest(projectCache);
    projectCache.set(cacheKey, projectId);
    return projectId;
  }
  return undefined;
}

/** Exported for tests. */
export function clearAntigravityProjectCache(): void {
  projectCache.clear();
  onboardAttemptedCache.clear();
  onboardLocks.clear();
}

/** Exported for tests — inspect cache state. */
export function getAntigravityProjectFromCache(
  accessToken: string,
  clientProfile: AntigravityClientProfile = "ide"
): string | undefined {
  return projectCache.get(getProjectCacheKey(accessToken, clientProfile));
}

/** Exported for tests — re-export from upstream config. */
export { getAntigravityLoadCodeAssistUrls } from "../config/antigravityUpstream.ts";
