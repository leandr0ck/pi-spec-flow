/**
 * Read-only status inspection for external orchestrators.
 *
 * This module deliberately delegates ticket parsing, ordering and config
 * resolution to the existing filesystem store. It never creates a store,
 * changes a ticket, starts a session, or invokes a model.
 */
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  getCheckpointReviewConfig,
  getSpecFlowConfig,
  getTicketsFolder,
  initTicketsStore,
  listTickets,
  listTicketsForSpec,
  ticketsExist,
  type Ticket,
} from "./tickets-fs.js";
import { loadCheckpointHandoff } from "./checkpoint-handoffs.js";
import {
  loadPlanningContext,
  loadPlanningContextBySpecPath,
} from "./planning-context.js";

export interface SpecFlowStatusOptions {
  featureKey?: string;
  specPath?: string;
}

export interface SpecFlowStatusNextTicket {
  id: number;
  title: string;
  featureKey: string;
  status: "pending" | "in_progress";
  isCheckpoint: boolean;
}

export interface SpecFlowStatus {
  sourceSpecPath: string | null;
  featureKey: string | null;
  ticketsFolder: string;
  total: number;
  pending: number;
  inProgress: number;
  done: number;
  checkpoints: {
    total: number;
    completed: number;
    pendingReview: number;
  };
  nextTicket?: SpecFlowStatusNextTicket;
  complete: boolean;
  issues: string[];
}

function toStoredSpecPath(cwd: string, specPath: string): string {
  const absolutePath = resolve(cwd, specPath);
  const storedPath = relative(cwd, absolutePath);
  if (storedPath && !storedPath.startsWith("..") && !isAbsolute(storedPath)) {
    return storedPath;
  }
  return specPath;
}

function uniqueFeatureKeys(tickets: Ticket[]): string[] {
  return Array.from(new Set(tickets.map((ticket) => ticket.feature_key).filter(Boolean))).sort();
}

function safeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "feature";
}

function hasCheckpointReviewReport(cwd: string, featureKey: string, checkpointTicketId: number): boolean {
  const reviewDir = resolve(cwd, ".spec-flow", "checkpoint-reviews");
  if (!existsSync(reviewDir)) return false;

  const prefix = `${safeFilePart(featureKey)}--checkpoint-${checkpointTicketId}--`;
  try {
    return readdirSync(reviewDir).some((file) => file.startsWith(prefix) && file.endsWith(".md"));
  } catch {
    return false;
  }
}

function nextTicket(tickets: Ticket[]): SpecFlowStatusNextTicket | undefined {
  const candidate = tickets.find((ticket) => ticket.status === "in_progress")
    ?? tickets.find((ticket) => ticket.status === "pending");
  if (!candidate || candidate.status === "done") return undefined;

  return {
    id: candidate.id,
    title: candidate.title,
    featureKey: candidate.feature_key,
    status: candidate.status,
    isCheckpoint: candidate.is_checkpoint,
  };
}

function statusForTickets(
  cwd: string,
  tickets: Ticket[],
  sourceSpecPath: string | null,
  featureKey: string | null,
  issues: string[],
): SpecFlowStatus {
  const pending = tickets.filter((ticket) => ticket.status === "pending").length;
  const inProgress = tickets.filter((ticket) => ticket.status === "in_progress").length;
  const done = tickets.filter((ticket) => ticket.status === "done").length;
  const checkpoints = tickets.filter((ticket) => ticket.is_checkpoint);
  const completedCheckpoints = checkpoints.filter((ticket) => ticket.status === "done");
  const reviewConfig = getCheckpointReviewConfig();

  let pendingReview = 0;
  for (const checkpoint of completedCheckpoints) {
    const handoff = loadCheckpointHandoff(cwd, checkpoint.feature_key, checkpoint.id);
    if (!handoff) {
      issues.push(`Checkpoint #${checkpoint.id} is done but its handoff is missing.`);
      continue;
    }

    if (
      reviewConfig.enabled
      && reviewConfig.skills.length > 0
      && !hasCheckpointReviewReport(cwd, checkpoint.feature_key, checkpoint.id)
    ) {
      pendingReview += 1;
    }
  }

  const complete = tickets.length > 0
    && done === tickets.length
    && pendingReview === 0
    && issues.length === 0;
  const upcomingTicket = nextTicket(tickets);

  return {
    sourceSpecPath,
    featureKey,
    ticketsFolder: getTicketsFolder(),
    total: tickets.length,
    pending,
    inProgress,
    done,
    checkpoints: {
      total: checkpoints.length,
      completed: completedCheckpoints.length,
      pendingReview,
    },
    ...(upcomingTicket ? { nextTicket: upcomingTicket } : {}),
    complete,
    issues,
  };
}

/**
 * Inspect one spec-flow feature without mutating the repository.
 *
 * Callers should provide either `featureKey` or `specPath` when more than one
 * feature exists. An omitted selector is accepted only for a single feature.
 */
export function inspectSpecFlowStatus(
  cwd: string,
  options: SpecFlowStatusOptions = {},
): SpecFlowStatus {
  const issues: string[] = [];
  const requestedFeature = options.featureKey?.trim() || null;
  const requestedSpecPath = options.specPath?.trim()
    ? toStoredSpecPath(cwd, options.specPath.trim())
    : null;
  const featureContext = requestedFeature ? loadPlanningContext(cwd, requestedFeature) : null;
  const specContext = requestedSpecPath
    ? loadPlanningContextBySpecPath(cwd, requestedSpecPath)
    : null;

  if (
    featureContext
    && specContext
    && featureContext.featureKey !== specContext.featureKey
  ) {
    issues.push(
      `Selectors are ambiguous: feature "${requestedFeature}" and spec "${requestedSpecPath}" refer to different features.`,
    );
  }

  initTicketsStore(cwd, {
    sourceSpecPath: specContext?.sourceSpecPath
      ?? featureContext?.sourceSpecPath
      ?? requestedSpecPath,
    ticketsFolder: specContext?.ticketsFolder ?? featureContext?.ticketsFolder,
    ticketsFolderBase: specContext?.ticketsFolderBase ?? featureContext?.ticketsFolderBase,
  });

  if (!ticketsExist()) {
    issues.push("No tickets store found. Run /spec-flow-init first.");
    return statusForTickets(cwd, [], requestedSpecPath, requestedFeature, issues);
  }

  const allTickets = listTickets();
  if (allTickets.length === 0) {
    issues.push("No tickets found. Create tickets first.");
    return statusForTickets(cwd, [], requestedSpecPath, requestedFeature, issues);
  }

  const allFeatures = uniqueFeatureKeys(allTickets);
  let selectedFeature = featureContext?.featureKey ?? requestedFeature;

  if (requestedSpecPath) {
    const effectiveTicketsFolderBase = specContext?.ticketsFolderBase
      ?? featureContext?.ticketsFolderBase
      ?? getSpecFlowConfig(cwd).ticketsFolderBase;
    // In spec-local mode the resolved ticket directory is already scoped by
    // the requested spec. The persisted source path may refer to a previous
    // repository lifecycle directory (for example ready/ → doing/), so it is
    // not used as a second filter.
    const specTickets = effectiveTicketsFolderBase === "spec"
      ? allTickets
      : allTickets.filter(
        (ticket) => toStoredSpecPath(cwd, ticket.source_spec_path ?? "") === requestedSpecPath,
      );
    const specFeatures = uniqueFeatureKeys(specTickets);

    if (specFeatures.length > 1) {
      issues.push(`Spec path "${requestedSpecPath}" matches multiple features: ${specFeatures.join(", ")}.`);
    } else if (specFeatures.length === 1) {
      selectedFeature = specFeatures[0];
    } else if (!selectedFeature) {
      issues.push(`No tickets found for spec path "${requestedSpecPath}".`);
    }
  }

  if (!selectedFeature && allFeatures.length > 1) {
    issues.push(`Feature selector is ambiguous. Choose one of: ${allFeatures.join(", ")}.`);
    return statusForTickets(cwd, [], requestedSpecPath, null, issues);
  }

  selectedFeature ??= allFeatures[0] ?? null;
  if (selectedFeature && !allFeatures.includes(selectedFeature)) {
    issues.push(`Feature "${selectedFeature}" was not found. Available: ${allFeatures.join(", ")}.`);
    return statusForTickets(cwd, [], requestedSpecPath, selectedFeature, issues);
  }

  const tickets = selectedFeature ? listTicketsForSpec(selectedFeature) : allTickets;
  const sourceSpecPath = featureContext?.sourceSpecPath
    ?? specContext?.sourceSpecPath
    ?? tickets.find((ticket) => ticket.source_spec_path)?.source_spec_path
    ?? requestedSpecPath;

  return statusForTickets(cwd, tickets, sourceSpecPath, selectedFeature, issues);
}
