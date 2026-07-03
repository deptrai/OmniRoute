/**
 * usage/windsurf.ts — Windsurf (Codeium) usage fetcher.
 *
 * Calls the Codeium cloud SeatManagementService/GetUserStatus Connect-RPC endpoint
 * to retrieve plan info, daily/weekly quota percentages, and credit-based usage.
 *
 * Endpoint: POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus
 * Auth: API key (sk-ws-... or devin-session-token$...) in metadata.apiKey
 * Protocol: Connect-RPC v1 (JSON over HTTP)
 *
 * Response shape:
 *   userStatus.planStatus.planInfo.planName              "Free" | "Pro" | "Teams" | "Free Trial"
 *   userStatus.planStatus.dailyQuotaRemainingPercent      0-100 (daily quota remaining %)
 *   userStatus.planStatus.weeklyQuotaRemainingPercent     0-100 (weekly quota remaining %)
 *   userStatus.planStatus.dailyQuotaResetAtUnix           Unix seconds (daily reset)
 *   userStatus.planStatus.weeklyQuotaResetAtUnix          Unix seconds (weekly reset)
 *   userStatus.planStatus.planStart                       ISO 8601 (billing cycle start)
 *   userStatus.planStatus.planEnd                         ISO 8601 (billing cycle end)
 *   userStatus.planStatus.availablePromptCredits          total pool (negative = unlimited)
 *   userStatus.planStatus.usedPromptCredits               consumed
 *   userStatus.planStatus.availableFlexCredits            flex pool (optional)
 *   userStatus.planStatus.usedFlexCredits                 flex consumed (optional)
 *
 * Reverse-engineered from openusage (robinebers/openusage) and CodexBar (steipete/CodexBar).
 */

import { type UsageQuota, parseResetTime } from "./quota.ts";

const WINDSURF_GET_USER_STATUS_URL =
  "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus";

/** Credits are stored in hundredths (e.g. 50000 = 500 credits). */
const CREDITS_DIVISOR = 100;

type JsonRecord = Record<string, unknown>;

/**
 * Fetch Windsurf usage via the Codeium cloud GetUserStatus RPC.
 * @param apiKey - Windsurf API key (sk-ws-... or devin-session-token$...)
 */
export async function getWindsurfUsage(apiKey: string): Promise<{
  plan?: string;
  quotas?: Record<string, UsageQuota>;
  message?: string;
}> {
  try {
    if (!apiKey) {
      return { message: "No Windsurf API key available." };
    }

    const body = JSON.stringify({
      metadata: {
        apiKey,
        ideName: "windsurf",
        ideVersion: "2.0.0",
        extensionName: "Codeium",
        extensionVersion: "2.0.0",
      },
    });

    const response = await fetch(WINDSURF_GET_USER_STATUS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          message:
            "Windsurf token expired or access denied. Please re-authenticate the connection.",
        };
      }
      const text = await response.text().catch(() => "");
      throw new Error(`Windsurf API error: ${response.status} ${text}`.trim());
    }

    const data = (await response.json()) as JsonRecord;
    const userStatus = toRecord(data.userStatus);
    const planStatus = toRecord(userStatus.planStatus);
    const planInfo = toRecord(planStatus.planInfo);

    const planName = String(planInfo.planName || "unknown");
    const planEnd = planStatus.planEnd as string | undefined;

    const quotas: Record<string, UsageQuota> = {};

    // ── Daily quota (rolling 24h window) ────────────────────────────────────
    // dailyQuotaRemainingPercent: 0-100, directly from API.
    // dailyQuotaResetAtUnix: Unix seconds → convert to ms for parseResetTime.
    const dailyRemainingPercent = toNumber(planStatus.dailyQuotaRemainingPercent, -1);
    if (dailyRemainingPercent >= 0) {
      const dailyResetUnix = toNumber(planStatus.dailyQuotaResetAtUnix, 0);
      quotas.daily = {
        used: 100 - dailyRemainingPercent,
        total: 100,
        remaining: dailyRemainingPercent,
        remainingPercentage: clampPercentage(dailyRemainingPercent),
        resetAt: dailyResetUnix > 0 ? parseResetTime(dailyResetUnix * 1000) : null,
        unlimited: false,
        displayName: "Daily Quota",
      };
    }

    // ── Weekly quota (rolling 7d window) ───────────────────────────────────
    // weeklyQuotaRemainingPercent: 0-100, directly from API.
    // weeklyQuotaResetAtUnix: Unix seconds → convert to ms for parseResetTime.
    const weeklyRemainingPercent = toNumber(planStatus.weeklyQuotaRemainingPercent, -1);
    if (weeklyRemainingPercent >= 0) {
      const weeklyResetUnix = toNumber(planStatus.weeklyQuotaResetAtUnix, 0);
      quotas.weekly = {
        used: 100 - weeklyRemainingPercent,
        total: 100,
        remaining: weeklyRemainingPercent,
        remainingPercentage: clampPercentage(weeklyRemainingPercent),
        resetAt: weeklyResetUnix > 0 ? parseResetTime(weeklyResetUnix * 1000) : null,
        unlimited: false,
        displayName: "Weekly Quota",
      };
    }

    // ── Prompt credits (monthly billing cycle) ─────────────────────────────
    // Negative availablePromptCredits or monthlyPromptCredits = unlimited.
    const monthlyPromptCredits = toNumber(planInfo.monthlyPromptCredits, -1);
    const availablePromptCredits = toNumber(planStatus.availablePromptCredits, -1);
    const usedPromptCredits = toNumber(planStatus.usedPromptCredits, 0);

    if (availablePromptCredits < 0 || monthlyPromptCredits < 0) {
      quotas.prompt_credits = {
        used: usedPromptCredits / CREDITS_DIVISOR,
        total: 0,
        remaining: 0,
        remainingPercentage: 100,
        resetAt: parseResetTime(planEnd),
        unlimited: true,
        displayName: "Prompt Credits",
      };
    } else {
      const total = availablePromptCredits + usedPromptCredits;
      const used = usedPromptCredits;
      const remaining = Math.max(total - used, 0);
      quotas.prompt_credits = {
        used: used / CREDITS_DIVISOR,
        total: total / CREDITS_DIVISOR,
        remaining: remaining / CREDITS_DIVISOR,
        remainingPercentage: total > 0 ? clampPercentage((remaining / total) * 100) : 0,
        resetAt: parseResetTime(planEnd),
        unlimited: false,
        displayName: "Prompt Credits",
      };
    }

    // ── Flex credits — optional add-on pool ────────────────────────────────
    const availableFlexCredits = toNumber(planStatus.availableFlexCredits, -1);
    const usedFlexCredits = toNumber(planStatus.usedFlexCredits, 0);

    if (availableFlexCredits >= 0) {
      const flexTotal = availableFlexCredits + usedFlexCredits;
      const flexRemaining = Math.max(flexTotal - usedFlexCredits, 0);
      quotas.flex_credits = {
        used: usedFlexCredits / CREDITS_DIVISOR,
        total: flexTotal / CREDITS_DIVISOR,
        remaining: flexRemaining / CREDITS_DIVISOR,
        remainingPercentage: flexTotal > 0 ? clampPercentage((flexRemaining / flexTotal) * 100) : 0,
        resetAt: parseResetTime(planEnd),
        unlimited: false,
        displayName: "Flex Credits",
      };
    }

    return {
      plan: planName,
      quotas,
    };
  } catch (error) {
    return { message: `Failed to fetch Windsurf usage: ${(error as Error).message}` };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampPercentage(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, p));
}
