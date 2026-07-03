/**
 * usage/windsurf.ts — Windsurf (Codeium) usage fetcher.
 *
 * Calls the Codeium cloud SeatManagementService/GetUserStatus Connect-RPC endpoint
 * to retrieve plan info and credit-based usage for the current billing cycle.
 *
 * Endpoint: POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus
 * Auth: API key (sk-ws-... or devin-session-token$...) in metadata.apiKey
 * Protocol: Connect-RPC v1 (JSON over HTTP)
 *
 * Response shape (credit values are in hundredths — divide by 100 for display):
 *   userStatus.planStatus.planInfo.planName           "Free" | "Pro" | "Teams" | "Free Trial"
 *   userStatus.planStatus.planInfo.monthlyPromptCredits
 *   userStatus.planStatus.availablePromptCredits       total pool (negative = unlimited)
 *   userStatus.planStatus.usedPromptCredits            consumed
 *   userStatus.planStatus.availableFlexCredits         flex pool (optional)
 *   userStatus.planStatus.usedFlexCredits              flex consumed (optional)
 *   userStatus.planStatus.planStart                    ISO 8601
 *   userStatus.planStatus.planEnd                      ISO 8601
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
    const planStart = planStatus.planStart as string | undefined;

    const quotas: Record<string, UsageQuota> = {};

    // Prompt credits — the primary usage metric.
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

    // Flex credits — optional add-on pool (not all plans have this).
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
