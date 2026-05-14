/**
 * Lightweight in-process loop state for ticket creation/validation loops.
 * Persisted to .spec-flow/loop.state.json so compaction doesn't lose state.
 *
 * Pattern: one active loop at a time (single-producer, single-consumer).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

const LOOP_DIR = ".spec-flow";
const STATE_FILE = "loop.state.json";

export interface TicketLoopState {
  name: string;
  iteration: number;
  maxIterations: number;
  status: "active" | "completed" | "stopped";
  startedAt: string;
  completedAt?: string;
}

const DEFAULT_MAX_ITERATIONS = 3;

// ── File helpers ────────────────────────────────────────────

function loopDir(cwd: string): string {
  return resolve(cwd, LOOP_DIR);
}

function statePath(cwd: string): string {
  return resolve(loopDir(cwd), STATE_FILE);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function tryRead(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function tryDelete(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      writeFileSync(filePath, "{}", "utf-8"); // don't delete dir, just clear
    }
  } catch {
    /* ignore */
  }
}

// ── Public API ──────────────────────────────────────────────

export function loadLoopState(cwd: string): TicketLoopState | null {
  const content = tryRead(statePath(cwd));
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    if (!parsed.name || !parsed.status) return null;
    return parsed as TicketLoopState;
  } catch {
    return null;
  }
}

export function saveLoopState(
  cwd: string,
  state: TicketLoopState,
): void {
  const p = statePath(cwd);
  ensureDir(dirname(p));
  writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
}

export function createLoopState(
  cwd: string,
  name: string,
  maxIterations: number = DEFAULT_MAX_ITERATIONS,
): TicketLoopState {
  const state: TicketLoopState = {
    name,
    iteration: 1,
    maxIterations,
    status: "active",
    startedAt: new Date().toISOString(),
  };
  saveLoopState(cwd, state);
  return state;
}

export function clearLoopState(cwd: string): void {
  const p = statePath(cwd);
  tryDelete(p);
  // also try to remove if empty
  try {
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf-8");
      if (raw === "{}") {
        // reset to fresh
      }
    }
  } catch {
    /* ignore */
  }
}

export function resumeLoopState(cwd: string): TicketLoopState | null {
  const state = loadLoopState(cwd);
  if (!state || state.status !== "active") return null;
  state.iteration++;
  saveLoopState(cwd, state);
  return state;
}
