/**
 * Filesystem-based ticket store for spec-flow extension.
 * Replaces db.ts — tickets are stored as Markdown files with YAML frontmatter.
 *
 * Folder structure:
 *   {ticketsFolder}/{feature-name}/
 *     001-ticket-slug.md
 *     002-ticket-slug.md
 *
 * Default ticketsFolder: ./docs/features (configurable via spec-flow.config.json)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { resolve, dirname, basename, extname, join } from "node:path";

// ── Constants ───────────────────────────────────────────────

const CONFIG_FILE = "spec-flow.config.json";
const DEFAULT_TICKETS_FOLDER = "./docs/features";

// ── Types (mirrors db.ts for drop-in replacement) ───────────

export interface Ticket {
  id: number;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "done";
  source_section: string;
  spec_file: string;

  acceptance_criteria: string | null;
  verification: string | null;
  dependencies: string | null;
  files_touched: string | null;
  estimated_scope: string | null;
  phase: string | null;
  is_checkpoint: number;
  risks: string | null;
  open_questions: string | null;
  order_index: number | null;

  created_at: string;
  updated_at: string;
}

export interface CreateTicketInput {
  title: string;
  description: string;
  source_section: string;
  spec_file: string;

  acceptance_criteria?: string;
  verification?: string;
  dependencies?: string;
  files_touched?: string;
  estimated_scope?: string;
  phase?: string;
  is_checkpoint?: boolean;
  risks?: string;
  open_questions?: string;
  order_index?: number;
}

// ── Internal state ──────────────────────────────────────────

let _ticketsFolder: string = "";

// ── Config loading ───────────────────────────────────────────

function loadConfig(cwd: string): { ticketsFolder: string } {
  const configPath = resolve(cwd, CONFIG_FILE);
  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    if (config.ticketsFolder && typeof config.ticketsFolder === "string") {
      return { ticketsFolder: config.ticketsFolder };
    }
  } catch {
    // File missing or invalid — use default
  }
  return { ticketsFolder: DEFAULT_TICKETS_FOLDER };
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ── Public API ──────────────────────────────────────────────

/**
 * Initialize the tickets filesystem store.
 * Reads config to determine the tickets folder and ensures it exists.
 */
export function initTicketsStore(cwd: string): void {
  const config = loadConfig(cwd);
  _ticketsFolder = resolve(cwd, config.ticketsFolder);
  ensureDir(_ticketsFolder);
}

/**
 * Check whether the tickets folder has been initialised.
 */
export function ticketsExist(): boolean {
  return _ticketsFolder !== "" && existsSync(_ticketsFolder);
}

/**
 * Return the resolved tickets folder path.
 */
export function getTicketsFolder(): string {
  return _ticketsFolder;
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Derive the feature folder name from a spec file path (basename without extension).
 * e.g. "spec.md" → "spec",  "frontend/spec.md" → "spec"
 */
function featureFolderFromSpec(specFile: string): string {
  const base = basename(specFile);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/**
 * Build the full path to a feature folder.
 */
function featurePath(specFile: string): string {
  if (!_ticketsFolder) throw new Error("Tickets store not initialised. Call initTicketsStore(cwd) first.");
  return resolve(_ticketsFolder, featureFolderFromSpec(specFile));
}

/**
 * Generate a safe filename slug from a title.
 */
function titleSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "ticket";
}

/**
 * Build the filename for a ticket.
 */
function ticketFilename(t: { order_index?: number | null; id: number; title: string }): string {
  const prefix = t.order_index != null
    ? String(t.order_index).padStart(3, "0")
    : String(t.id).padStart(3, "0");
  return `${prefix}-${titleSlug(t.title)}.md`;
}

/**
 * Find the next available ID across all feature folders.
 */
function nextId(featureFolder: string, allFolders?: string[]): number {
  let maxId = 0;

  // Search in all feature folders if we want a global ID
  const foldersToSearch = allFolders
    ? allFolders.map(f => resolve(_ticketsFolder, f))
    : [featureFolder];

  for (const folder of foldersToSearch) {
    if (!existsSync(folder)) continue;
    for (const file of readdirSync(folder)) {
      if (!file.endsWith(".md")) continue;
      const ticket = parseTicket(join(folder, file));
      if (ticket && ticket.id > maxId) {
        maxId = ticket.id;
      }
    }
  }

  return maxId + 1;
}

// ── Frontmatter parsing / serialisation ─────────────────────

/**
 * Escape a string value for YAML single-line.
 */
function yamlEscape(val: string): string {
  if (/[:\[\]{},&*?|>!%@`#"']/.test(val) || val.includes("\n")) {
    return JSON.stringify(val);
  }
  return val;
}

/**
 * Serialise a Ticket to a Markdown file string (YAML frontmatter + body).
 */
function ticketToMd(ticket: Ticket): string {
  const lines: string[] = ["---"];

  const fields: Array<[string, unknown]> = [
    ["id", ticket.id],
    ["title", ticket.title],
    ["status", ticket.status],
    ["source_section", ticket.source_section],
    ["spec_file", ticket.spec_file],
    ["acceptance_criteria", ticket.acceptance_criteria],
    ["verification", ticket.verification],
    ["dependencies", ticket.dependencies],
    ["files_touched", ticket.files_touched],
    ["estimated_scope", ticket.estimated_scope],
    ["phase", ticket.phase],
    ["is_checkpoint", ticket.is_checkpoint],
    ["risks", ticket.risks],
    ["open_questions", ticket.open_questions],
    ["order_index", ticket.order_index],
    ["created_at", ticket.created_at],
    ["updated_at", ticket.updated_at],
  ];

  for (const [key, val] of fields) {
    if (val === null || val === undefined) continue;
    if (typeof val === "boolean") {
      lines.push(`${key}: ${val}`);
    } else if (typeof val === "number") {
      lines.push(`${key}: ${val}`);
    } else if (typeof val === "string") {
      const escaped = yamlEscape(val);
      // If the value is multi-line or needs quoting, use JSON
      if (escaped.startsWith('"')) {
        lines.push(`${key}: ${escaped}`);
      } else {
        lines.push(`${key}: ${val}`);
      }
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(`# ${ticket.title}`);
  lines.push("");
  lines.push(ticket.description || "(no description)");

  if (ticket.acceptance_criteria) {
    lines.push("");
    lines.push("## Acceptance Criteria");
    lines.push(ticket.acceptance_criteria);
  }

  if (ticket.verification) {
    lines.push("");
    lines.push("## Verification");
    lines.push(ticket.verification);
  }

  if (ticket.files_touched) {
    lines.push("");
    lines.push("## Files");
    lines.push(ticket.files_touched);
  }

  if (ticket.risks) {
    lines.push("");
    lines.push("## Risks");
    lines.push(ticket.risks);
  }

  if (ticket.open_questions) {
    lines.push("");
    lines.push("## Open Questions");
    lines.push(ticket.open_questions);
  }

  lines.push(""); // trailing newline
  return lines.join("\n");
}

/**
 * Parse a single YAML frontmatter line, trimming whitespace.
 */
function parseYamlLine(line: string): [string, unknown] | null {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return null;
  const key = line.slice(0, colonIdx).trim();
  const rawVal = line.slice(colonIdx + 1).trim();

  if (!key) return null;

  // Boolean
  if (rawVal === "true") return [key, true];
  if (rawVal === "false") return [key, false];

  // Number
  const num = Number(rawVal);
  if (!isNaN(num) && rawVal !== "") return [key, num];

  // Quoted string (JSON)
  if ((rawVal.startsWith('"') && rawVal.endsWith('"')) ||
      (rawVal.startsWith("'") && rawVal.endsWith("'"))) {
    try {
      return [key, JSON.parse(rawVal)];
    } catch {
      return [key, rawVal.slice(1, -1)];
    }
  }

  // Plain string
  return [key, rawVal];
}

/**
 * Parse frontmatter and body from a Markdown file string.
 * Returns [frontmatter map, description].
 */
function parseFrontmatter(raw: string): [Record<string, unknown>, string] {
  const fm: Record<string, unknown> = {};
  const lines = raw.split("\n");

  if (lines.length < 2 || lines[0].trim() !== "---") {
    return [fm, raw];
  }

  let endFm = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endFm = i;
      break;
    }
    const parsed = parseYamlLine(lines[i]);
    if (parsed) {
      fm[parsed[0]] = parsed[1];
    }
  }

  // Everything after --- is the body
  const bodyStart = endFm + 1;
  const body = lines.slice(bodyStart).join("\n").trim();
  return [fm, body];
}

/**
 * Parse a Ticket from a Markdown file on disk.
 */
function parseTicket(filepath: string): Ticket | null {
  try {
    const raw = readFileSync(filepath, "utf-8");
    const [fm, description] = parseFrontmatter(raw);

    const id = fm.id;
    if (typeof id !== "number") return null;

    const status = (fm.status as string) || "pending";
    if (!["pending", "in_progress", "done"].includes(status)) return null;

    return {
      id,
      title: (fm.title as string) || "",
      description: description || (fm.description as string) || "",
      status: status as "pending" | "in_progress" | "done",
      source_section: (fm.source_section as string) || "",
      spec_file: (fm.spec_file as string) || "",
      acceptance_criteria: (fm.acceptance_criteria as string) || null,
      verification: (fm.verification as string) || null,
      dependencies: (fm.dependencies as string) || null,
      files_touched: (fm.files_touched as string) || null,
      estimated_scope: (fm.estimated_scope as string) || null,
      phase: (fm.phase as string) || null,
      is_checkpoint: fm.is_checkpoint === true ? 1 : 0,
      risks: (fm.risks as string) || null,
      open_questions: (fm.open_questions as string) || null,
      order_index: typeof fm.order_index === "number" ? fm.order_index : null,
      created_at: (fm.created_at as string) || new Date().toISOString(),
      updated_at: (fm.updated_at as string) || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Collect all .md ticket files across all feature folders,
 * parse them, and return sorted by id.
 */
function collectAllTickets(): Ticket[] {
  if (!_ticketsFolder || !existsSync(_ticketsFolder)) return [];

  const tickets: Ticket[] = [];

  for (const entry of readdirSync(_ticketsFolder)) {
    const entryPath = resolve(_ticketsFolder, entry);
    if (!existsSync(entryPath)) continue;
    if (!readdirSync(entryPath).some(f => f.endsWith(".md"))) continue;

    for (const file of readdirSync(entryPath)) {
      if (!file.endsWith(".md")) continue;
      const ticket = parseTicket(join(entryPath, file));
      if (ticket) tickets.push(ticket);
    }
  }

  return tickets.sort((a, b) => a.id - b.id);
}

/**
 * Find the filepath of a ticket by its ID, searching all feature folders.
 */
function findTicketFile(id: number): string | null {
  if (!_ticketsFolder || !existsSync(_ticketsFolder)) return null;

  for (const entry of readdirSync(_ticketsFolder)) {
    const entryPath = resolve(_ticketsFolder, entry);
    if (!existsSync(entryPath)) continue;

    for (const file of readdirSync(entryPath)) {
      if (!file.endsWith(".md")) continue;
      const ticket = parseTicket(join(entryPath, file));
      if (ticket && ticket.id === id) {
        return join(entryPath, file);
      }
    }
  }

  return null;
}

// ── Public CRUD operations ──────────────────────────────────

/**
 * Insert a ticket with minimal fields.
 */
export function insertTicket(input: {
  title: string;
  description: string;
  source_section: string;
  spec_file: string;
}): Ticket {
  const fullInput: CreateTicketInput = { ...input };
  return insertFullTicket(fullInput);
}

/**
 * Insert a ticket with full planning-and-task-breakdown fields.
 */
export function insertFullTicket(input: CreateTicketInput): Ticket {
  if (!_ticketsFolder) throw new Error("Tickets store not initialised. Call initTicketsStore(cwd) first.");

  const featureDir = featurePath(input.spec_file);
  ensureDir(featureDir);

  // Collect existing feature folders for global ID assignment
  const allFolders = existsSync(_ticketsFolder)
    ? readdirSync(_ticketsFolder).filter(f => {
        const p = resolve(_ticketsFolder, f);
        return existsSync(p);
      })
    : [];

  const now = new Date().toISOString();

  const ticket: Ticket = {
    id: nextId(featureDir, allFolders),
    title: input.title,
    description: input.description,
    status: "pending",
    source_section: input.source_section,
    spec_file: input.spec_file,
    acceptance_criteria: input.acceptance_criteria ?? null,
    verification: input.verification ?? null,
    dependencies: input.dependencies ?? null,
    files_touched: input.files_touched ?? null,
    estimated_scope: input.estimated_scope ?? null,
    phase: input.phase ?? null,
    is_checkpoint: input.is_checkpoint ? 1 : 0,
    risks: input.risks ?? null,
    open_questions: input.open_questions ?? null,
    order_index: input.order_index ?? null,
    created_at: now,
    updated_at: now,
  };

  const mdContent = ticketToMd(ticket);
  const destFile = join(featureDir, ticketFilename(ticket));
  writeFileSync(destFile, mdContent, "utf-8");

  return ticket;
}

/**
 * List all tickets, optionally filtered by status.
 */
export function listTickets(status?: string): Ticket[] {
  const all = collectAllTickets();

  if (status) {
    return all.filter(t => t.status === status);
  }

  return all;
}

/**
 * Get a single ticket by ID.
 */
export function getTicket(id: number): Ticket | undefined {
  const filepath = findTicketFile(id);
  if (!filepath) return undefined;

  const ticket = parseTicket(filepath);
  return ticket ?? undefined;
}

/**
 * Update a ticket's status and return the updated ticket.
 */
export function updateTicketStatus(
  id: number,
  status: "pending" | "in_progress" | "done"
): Ticket | undefined {
  const filepath = findTicketFile(id);
  if (!filepath) return undefined;

  const ticket = parseTicket(filepath);
  if (!ticket) return undefined;

  ticket.status = status;
  ticket.updated_at = new Date().toISOString();

  const mdContent = ticketToMd(ticket);
  writeFileSync(filepath, mdContent, "utf-8");

  return ticket;
}

/**
 * Count all tickets.
 */
export function ticketCount(): number {
  return collectAllTickets().length;
}

/**
 * Clear all tickets (delete all files in all feature folders).
 */
/**
 * Delete a single ticket by ID. Returns true if deleted, false if not found.
 */
export function deleteTicket(id: number): boolean {
  const filepath = findTicketFile(id);
  if (!filepath) return false;
  try {
    rmSync(filepath);
    // Clean up empty feature folder
    const featureDir = dirname(filepath);
    if (existsSync(featureDir)) {
      const remaining = readdirSync(featureDir);
      if (remaining.length === 0) {
        rmSync(featureDir, { recursive: true });
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function clearTickets(): void {
  if (!_ticketsFolder || !existsSync(_ticketsFolder)) return;

  for (const entry of readdirSync(_ticketsFolder)) {
    const entryPath = resolve(_ticketsFolder, entry);
    if (!existsSync(entryPath)) continue;

    for (const file of readdirSync(entryPath)) {
      if (!file.endsWith(".md")) continue;
      rmSync(join(entryPath, file));
    }

    // Remove feature folder if empty
    const remaining = readdirSync(entryPath);
    if (remaining.length === 0) {
      rmSync(entryPath, { recursive: true });
    }
  }
}
