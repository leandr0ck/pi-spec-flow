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

export type CheckpointHandoffSections = {
  summary: string;
  keyOutcomes: string[];
  filesChanged: string[];
  keyDecisions: string[];
  verification: string[];
  openRisks: string[];
  nextRecommendedTicket: string;
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

function getCheckpointTicketFromBlock(tickets: Ticket[]): Ticket {
  return tickets.find((ticket) => ticket.is_checkpoint) ?? tickets[tickets.length - 1]!;
}

function splitBulletLines(value: string | null): string[] {
  if (!value) return [];

  return value
    .split(/\r?\n/)
    .map((entry) => entry.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
}

function splitFileEntries(value: string | null): string[] {
  if (!value) return [];

  return value
    .split(/\r?\n/)
    .flatMap((entry) => entry.split(/\s*,\s*/))
    .map((entry) => entry.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
}

function prefixedEntries(ticketId: number, value: string | null): string[] {
  return splitBulletLines(value).map((entry) => `#${ticketId}: ${entry}`);
}

export function buildCheckpointHandoffDraft(
  tickets: Ticket[],
  nextTicketId: number | null = null,
): string {
  if (tickets.length === 0) {
    throw new Error("Cannot build checkpoint handoff draft for empty ticket set.");
  }

  const checkpointTicket = getCheckpointTicketFromBlock(tickets);
  const featureKey = checkpointTicket.feature_key;
  const completedTickets = tickets.map((ticket) => `- #${ticket.id} ${ticket.title}`);
  const outcomes = uniqueNonEmpty(
    tickets.flatMap((ticket) => prefixedEntries(ticket.id, ticket.handoff_summary)),
  );
  const files = uniqueNonEmpty(tickets.flatMap((ticket) => splitFileEntries(ticket.handoff_files)));
  const decisions = uniqueNonEmpty(
    tickets.flatMap((ticket) => prefixedEntries(ticket.id, ticket.handoff_decisions)),
  );
  const verification = uniqueNonEmpty(
    tickets.flatMap((ticket) => prefixedEntries(ticket.id, ticket.handoff_verification)),
  );
  const risks = uniqueNonEmpty(
    tickets.flatMap((ticket) =>
      prefixedEntries(ticket.id, ticket.handoff_risks).filter(
        (entry) => !entry.replace(/^#\d+:\s*/, "").match(/^none$/i),
      ),
    ),
  );

  const nextRecommended =
    nextTicketId != null
      ? `#${nextTicketId}`
      : checkpointTicket.handoff_next_ticket?.trim() || "No remaining ticket recorded";

  return [
    `## Checkpoint handoff · ${featureKey} · checkpoint #${checkpointTicket.id}`,
    "",
    "### Status",
    `- Feature: ${featureKey}`,
    `- Completed block: #${tickets[0]!.id}–#${tickets[tickets.length - 1]!.id}`,
    `- Checkpoint ticket: #${checkpointTicket.id}`,
    `- Next recommended ticket: ${nextRecommended}`,
    "",
    "### Completed tickets",
    ...completedTickets,
    "",
    "### Key outcomes",
    ...(outcomes.length > 0 ? outcomes.map((entry) => `- ${entry}`) : ["- None recorded"]),
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
}

export function renderCheckpointHandoffContent(
  tickets: Ticket[],
  sections: CheckpointHandoffSections,
): string {
  if (tickets.length === 0) {
    throw new Error("Cannot render checkpoint handoff for empty ticket set.");
  }

  const checkpointTicket = getCheckpointTicketFromBlock(tickets);
  const featureKey = checkpointTicket.feature_key;
  const completedTickets = tickets.map((ticket) => `- #${ticket.id} ${ticket.title}`);

  return [
    `## Checkpoint handoff · ${featureKey} · checkpoint #${checkpointTicket.id}`,
    "",
    "### Status",
    `- Feature: ${featureKey}`,
    `- Completed block: #${tickets[0]!.id}–#${tickets[tickets.length - 1]!.id}`,
    `- Checkpoint ticket: #${checkpointTicket.id}`,
    `- Next recommended ticket: ${sections.nextRecommendedTicket}`,
    "",
    "### Summary",
    `- ${sections.summary.trim()}`,
    "",
    "### Completed tickets",
    ...completedTickets,
    "",
    "### Key outcomes",
    ...(sections.keyOutcomes.length > 0 ? sections.keyOutcomes.map((entry) => `- ${entry}`) : ["- None recorded"]),
    "",
    "### Files changed",
    ...(sections.filesChanged.length > 0 ? sections.filesChanged.map((entry) => `- ${entry}`) : ["- None recorded"]),
    "",
    "### Key decisions",
    ...(sections.keyDecisions.length > 0 ? sections.keyDecisions.map((entry) => `- ${entry}`) : ["- None recorded"]),
    "",
    "### Verification",
    ...(sections.verification.length > 0 ? sections.verification.map((entry) => `- ${entry}`) : ["- None recorded"]),
    "",
    "### Open risks",
    ...(sections.openRisks.length > 0 ? sections.openRisks.map((entry) => `- ${entry}`) : ["- None"]),
  ].join("\n");
}

export function createCheckpointHandoff(tickets: Ticket[], content: string): CheckpointHandoff {
  if (tickets.length === 0) {
    throw new Error("Cannot create checkpoint handoff for empty ticket set.");
  }

  const checkpointTicket = getCheckpointTicketFromBlock(tickets);
  const featureKey = checkpointTicket.feature_key;

  return {
    featureKey,
    checkpointTicketId: checkpointTicket.id,
    blockStartTicketId: tickets[0]!.id,
    blockEndTicketId: tickets[tickets.length - 1]!.id,
    ticketIds: tickets.map((ticket) => ticket.id),
    createdAt: new Date().toISOString(),
    content: content.trim(),
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
