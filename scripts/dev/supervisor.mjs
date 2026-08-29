#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const runNextPath = join(ROOT, "scripts", "dev", "run-next.mjs");
const logPath = join(process.env.HOME || "", ".omniroute", "dev-server.log");

let isShuttingDown = false;
let child = null;

function startServer() {
  if (isShuttingDown) return;

  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  console.log(`[Supervisor] Starting OmniRoute server via ${runNextPath}...`);

  const mode = process.argv[2] || "dev";
  child = spawn(process.execPath, [runNextPath, mode], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: process.env.DATA_DIR || join(process.env.HOME || "", ".omniroute"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  child.on("exit", (code, signal) => {
    logStream.end();
    if (isShuttingDown) {
      console.log("[Supervisor] Shutdown complete.");
      process.exit(0);
    }
    console.warn(
      `[Supervisor] Server exited (code: ${code}, signal: ${signal}). Respawning in 1s...`
    );
    setTimeout(startServer, 1000);
  });
}

process.on("SIGINT", () => {
  console.log("[Supervisor] SIGINT received. Shutting down child...");
  isShuttingDown = true;
  if (child) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 3000);
});

process.on("SIGTERM", () => {
  console.log("[Supervisor] SIGTERM received. Shutting down child...");
  isShuttingDown = true;
  if (child) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 3000);
});

startServer();
