/**
 * Windsurf / Devin CLI installation detection.
 * Purely filesystem-based — no shell interpolation (Hard Rule #13).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DetectionResult } from "../types.ts";

const HOME = os.homedir();
const PATHS = [
  "/usr/local/bin/devin",
  "/usr/bin/devin",
  path.join(HOME, ".local", "bin", "devin"),
  path.join(HOME, ".local", "share", "devin", "cli", "_versions"),
  path.join(process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming"), "npm", "devin.cmd"),
];

export function detectWindsurf(): DetectionResult {
  for (const p of PATHS) {
    if (fs.existsSync(p)) return { installed: true, path: p };
  }
  return { installed: false };
}
