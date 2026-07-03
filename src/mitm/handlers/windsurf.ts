/**
 * Windsurf / Devin CLI MITM handler (TS — for registry/infrastructure).
 *
 * The actual runtime interception is handled by the CJS handler in
 * `src/mitm/_internal/windsurfHandler.cjs` (invoked from server.cjs).
 * This TS class exists for the MitmTarget registry and future ESM wiring.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentId } from "../types";
import { MitmHandlerBase } from "./base";

export class WindsurfHandler extends MitmHandlerBase {
  readonly agentId: AgentId = "windsurf";

  async intercept(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    mappedModel: string
  ): Promise<void> {
    // The actual protobuf decode/translate/encode logic lives in the CJS
    // handler (windsurfHandler.cjs) which is called directly from server.cjs.
    // This TS handler is a placeholder for future ESM-based wiring.
    const startedAt = this.now();
    const intercepted = await this.hookBufferStart(req, body, mappedModel);

    try {
      // Forward as Anthropic /v1/messages — the CJS handler does the real work.
      // This path is only reached if the TS handler is invoked directly (future).
      const upstream = await this.fetchRouter(body, "/v1/messages", req.headers);

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => "");
        throw new Error(`OmniRoute ${upstream.status}: ${errText}`);
      }

      let collected = "";
      await this.pipeSSE(upstream, res, (chunk) => {
        collected += chunk.toString();
      });

      const total = this.now() - startedAt;
      this.hookBufferUpdate(intercepted, {
        status: upstream.status,
        responseHeaders: Object.fromEntries(upstream.headers.entries()),
        responseBody: collected,
        responseSize: Buffer.byteLength(collected),
        proxyLatencyMs: 0,
        upstreamLatencyMs: total,
      });
    } catch (err) {
      await this.hookBufferError(intercepted, err);
      await this.writeError(res, err);
    }
  }
}
