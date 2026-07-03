/**
 * Windsurf / Devin CLI — MITM target descriptor.
 *
 * Hosts: `server.codeium.com`.
 * Format: Connect-RPC protobuf — POST `/exa.api_server_pb.ApiServerService/GetChatMessage`.
 *
 * The handler decodes the protobuf body internally (binary, not JSON) so the
 * standard JSON model-extraction path in server.cjs is bypassed.
 */
import type { MitmTarget } from "../types";

export const WINDSURF_TARGET: MitmTarget = {
  id: "windsurf",
  name: "Windsurf / Devin CLI",
  icon: "sailing",
  color: "#00B4D8",
  hosts: ["server.codeium.com"],
  port: 443,
  endpointPatterns: ["/exa.api_server_pb.ApiServerService/GetChatMessage"],
  defaultModels: [
    { id: "ws/glm-5-2", name: "GLM 5.2", alias: "ws/glm-5-2" },
    { id: "ws/sonnet-4.6", name: "Claude Sonnet 4.6", alias: "ws/sonnet-4.6" },
    { id: "ws/swe-1-6", name: "SWE 1.6", alias: "ws/swe-1-6" },
  ],
  setupTutorial: {
    steps: [
      "Install Devin CLI (windsurf)",
      "Install OmniRoute's root certificate",
      "Enable DNS routing for Windsurf (server.codeium.com → 127.0.0.1)",
      "Run `devin` — requests are now proxied via OmniRoute",
    ],
    detection: { command: "which devin", platform: "all" },
  },
  handler: () => import("../handlers/windsurf").then((m) => ({ default: m.WindsurfHandler })),
  riskNoticeKey: "providers.riskNotice.oauth",
};
