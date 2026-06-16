import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export function appendDebugLog(
  cwd: string,
  scope: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  try {
    const dir = resolve(cwd, ".spec-flow");
    mkdirSync(dir, { recursive: true });
    const suffix = details ? ` ${JSON.stringify(details)}` : "";
    appendFileSync(
      resolve(dir, "debug.log"),
      `[${new Date().toISOString()}] [${scope}] ${message}${suffix}\n`,
      "utf8",
    );
  } catch {
    // Debug logging must never affect the workflow.
  }
}
