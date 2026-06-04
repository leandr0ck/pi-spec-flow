/**
 * Persist per-feature planning context so tickets can retain the real source spec path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const STATE_DIR = ".spec-flow";
const STATE_FILE = "planning-context.json";

export interface PlanningContextEntry {
  featureKey: string;
  sourceSpecPath: string;
  updatedAt: string;
}

type PlanningContextState = {
  entries: Record<string, PlanningContextEntry>;
};

function statePath(cwd: string): string {
  return resolve(cwd, STATE_DIR, STATE_FILE);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadState(cwd: string): PlanningContextState {
  try {
    const raw = readFileSync(statePath(cwd), "utf-8");
    const parsed = JSON.parse(raw) as PlanningContextState;
    if (parsed && parsed.entries && typeof parsed.entries === "object") {
      return parsed;
    }
  } catch {
    // ignore and fall through
  }

  return { entries: {} };
}

function saveState(cwd: string, state: PlanningContextState): void {
  const path = statePath(cwd);
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

export function savePlanningContext(
  cwd: string,
  featureKey: string,
  sourceSpecPath: string,
): void {
  const state = loadState(cwd);
  state.entries[featureKey] = {
    featureKey,
    sourceSpecPath,
    updatedAt: new Date().toISOString(),
  };
  saveState(cwd, state);
}

export function loadPlanningContext(
  cwd: string,
  featureKey: string,
): PlanningContextEntry | null {
  const state = loadState(cwd);
  return state.entries[featureKey] ?? null;
}
