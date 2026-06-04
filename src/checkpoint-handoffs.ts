import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { Ticket } from "./tickets-fs.js";
import { getPreviousCheckpointTicket } from "./checkpoints.js";

const HANDOFF_DIR = ".spec-flow/checkpoint-handoffs";

export type CheckpointHandoff = {
  featureKey: string;
  checkpointTicketId: number;
  blockStartTicketId: number;
  blockEndTicketId: number;
  ticketIds: number[];
  createdAt: string;
  content: string;
};

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function handoffPath(cwd: string, featureKey: string, checkpointTicketId: number): string {
  return resolve(cwd, HANDOFF_DIR, `${featureKey}--checkpoint-${checkpointTicketId}.json`);
}

function uniqueNonEmpty(lines: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const line of lines.map((entry) => entry.trim()).filter(Boolean)) {
    if (seen.has(line)) continue;
    seen.add(line);
    output.push(line);
  }

  return output;
}

function splitStructuredText(value: string | null): string[] {
  if (!value) return [];

  return value
    .split(/\r?\n|,/)
    .map((entry) => entry.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
}

export function synthesizeCheckpointHandoff(tickets: Ticket[]): CheckpointHandoff {
  if (tickets.length === 0) {
    throw new Error("Cannot synthesize checkpoint handoff for empty ticket set.");
  }

  const checkpointTicket = tickets.find((ticket) => ticket.is_checkpoint) ?? tickets[tickets.length - 1];
  const featureKey = checkpointTicket.feature_key;

  const completedTickets = tickets.map((ticket) => `- #${ticket.id} ${ticket.title}`);
  const files = uniqueNonEmpty(tickets.flatMap((ticket) => splitStructuredText(ticket.handoff_files)));
  const decisions = uniqueNonEmpty(
    tickets.flatMap((ticket) =>
      splitStructuredText(ticket.handoff_decisions).map((entry) => `#${ticket.id}: ${entry}`),
    ),
  );
  const verification = uniqueNonEmpty(
    tickets.flatMap((ticket) =>
      splitStructuredText(ticket.handoff_verification).map((entry) => `#${ticket.id}: ${entry}`),
    ),
  );
  const risks = uniqueNonEmpty(
    tickets.flatMap((ticket) =>
      splitStructuredText(ticket.handoff_risks)
        .filter((entry) => entry.toLowerCase() !== "none")
        .map((entry) => `#${ticket.id}: ${entry}`),
    ),
  );

  const content = [
    `## Checkpoint handoff · ${featureKey} · checkpoint #${checkpointTicket.id}`,
    "",
    "### Completed tickets",
    ...completedTickets,
    "",
    "### Files changed",
    ...(files.length > 0 ? files.map((entry) => `- ${entry}`) : ["- None recorded"]),
    "",
    "### Key decisions",
    ...(decisions.length > 0 ? decisions.map((entry) => `- ${entry}`) : ["- None recorded"]),
    "",
    "### Verification",
    ...(verification.length > 0 ? verification.map((entry) => `- ${entry}`) : ["- None recorded"]),
    "",
    "### Open risks",
    ...(risks.length > 0 ? risks.map((entry) => `- ${entry}`) : ["- None"]),
  ].join("\n");

  return {
    featureKey,
    checkpointTicketId: checkpointTicket.id,
    blockStartTicketId: tickets[0]!.id,
    blockEndTicketId: tickets[tickets.length - 1]!.id,
    ticketIds: tickets.map((ticket) => ticket.id),
    createdAt: new Date().toISOString(),
    content,
  };
}

export function saveCheckpointHandoff(cwd: string, handoff: CheckpointHandoff): void {
  const path = handoffPath(cwd, handoff.featureKey, handoff.checkpointTicketId);
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(handoff, null, 2), "utf-8");
}

export function loadCheckpointHandoff(
  cwd: string,
  featureKey: string,
  checkpointTicketId: number,
): CheckpointHandoff | null {
  const path = handoffPath(cwd, featureKey, checkpointTicketId);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, "utf-8")) as CheckpointHandoff;
  } catch {
    return null;
  }
}

export function loadPreviousCheckpointHandoff(
  cwd: string,
  orderedTickets: Ticket[],
  ticketId: number,
): CheckpointHandoff | null {
  const previousCheckpoint = getPreviousCheckpointTicket(orderedTickets, ticketId);
  if (!previousCheckpoint) return null;

  return loadCheckpointHandoff(cwd, previousCheckpoint.feature_key, previousCheckpoint.id);
}
