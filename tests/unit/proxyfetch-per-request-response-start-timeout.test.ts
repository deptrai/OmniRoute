/**
 * Per-request override of the direct-egress response-start bound
 * (`omniResponseStartTimeoutMs` fetch option).
 *
 * Motivation: SWE-2 / Devin Desktop legitimately needs >30 s before the
 * upstream sends response headers on large prompts. The shared
 * OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS=30s bound (#10214 stale-socket guard)
 * turned that slowness into 502s and repeatedly tripped the provider circuit
 * breaker. Callers may now pass a wider (or 0 = disabled) bound per request;
 * the option is OmniRoute-internal and must never reach undici/native fetch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyFetch } from "../../open-sse/utils/proxyFetch.ts";

function withFastEnvTimeout<T>(fn: () => Promise<T>): Promise<T> {
  process.env.OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS = "50";
  return fn().finally(() => {
    delete process.env.OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS;
  });
}

test("omniResponseStartTimeoutMs widens the bound so a >env-timeout response still succeeds", async () => {
  const seenKeys: string[][] = [];
  const mockUndici = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    seenKeys.push(Object.keys(init ?? {}));
    // Resolves at ~120ms — past the 50ms env bound, inside the 5s request bound.
    await new Promise((r) => setTimeout(r, 120));
    return new Response("ok", { status: 200 });
  };

  const res = await withFastEnvTimeout(() =>
    proxyFetch(
      "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage",
      { method: "POST", omniResponseStartTimeoutMs: 5000 } as RequestInit & {
        omniResponseStartTimeoutMs?: number;
      },
      { undiciFetch: mockUndici }
    )
  );

  assert.equal(await res.text(), "ok");
  for (const keys of seenKeys) {
    assert.ok(
      !keys.includes("omniResponseStartTimeoutMs"),
      "internal option must be stripped before reaching fetch impl"
    );
  }
});

test("omniResponseStartTimeoutMs=0 disables the bound entirely for that request", async () => {
  const mockUndici = async (): Promise<Response> => {
    await new Promise((r) => setTimeout(r, 120)); // >50ms env bound
    return new Response("ok", { status: 200 });
  };

  const res = await withFastEnvTimeout(() =>
    proxyFetch(
      "https://server.codeium.com/x",
      { method: "POST", omniResponseStartTimeoutMs: 0 } as RequestInit & {
        omniResponseStartTimeoutMs?: number;
      },
      { undiciFetch: mockUndici }
    )
  );
  assert.equal(await res.text(), "ok");
});

test("invalid omniResponseStartTimeoutMs falls back to the env bound", async () => {
  const mockUndici = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });

  await assert.rejects(
    withFastEnvTimeout(() =>
      proxyFetch(
        "https://server.codeium.com/x",
        { method: "POST", omniResponseStartTimeoutMs: Number.NaN } as RequestInit & {
          omniResponseStartTimeoutMs?: number;
        },
        { undiciFetch: mockUndici, nativeFetch: async () => new Response("nf") }
      )
    ),
    (err: unknown) => {
      assert.equal((err as { code?: unknown }).code, "DIRECT_RESPONSE_START_TIMEOUT");
      return true;
    }
  );
});
