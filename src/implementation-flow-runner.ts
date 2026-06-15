import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getCheckpointReviewConfig,
  getTicket,
  listTicketsForSpec,
  updateTicket,
  type Ticket,
} from "./tickets-fs.js";
import { formatTicketFull } from "./formatters.js";
import { getBlockForTicket, getNextTicketAfterBlock, getNextTicketInBlock } from "./checkpoints.js";
import { buildCheckpointHandoffDraft } from "./checkpoint-handoffs.js";
import { compactTicketInstruction, implementationProtocolLine } from "./prompt-builders.js";
import {
  armCheckpointReview,
  loadCheckpointReviewState,
  runCheckpointReviewEvent,
} from "./checkpoint-review-runner.js";

const STATE_KEY = "spec-flow-implementation-flow";
const STATUS_KEY = "spec-flow-implementation-flow";

type Phase =
  | "ticketDone"
  | "checkpointHandoffRequested"
  | "checkpointHandoffSaved"
  | "reviewPending"
  | "reviewRunning"
  | "done"
  | "error";

export type ImplementationFlowState = {
  runId: string;
  phase: Phase;
  ticketId: number;
  featureKey: string;
  autoNext: boolean;
  startedAt: number;
  updatedAt: number;
  lastError?: string;
};

function persist(pi: ExtensionAPI, state: ImplementationFlowState): void {
  state.updatedAt = Date.now();
  pi.appendEntry(STATE_KEY, state);
}

function loadState(ctx: {
  sessionManager: { getBranch: () => Array<{ type: string; customType?: string; data?: unknown }> };
}): ImplementationFlowState | undefined {
  let latest: ImplementationFlowState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === STATE_KEY) {
      latest = entry.data as ImplementationFlowState;
    }
  }
  return latest;
}

export function hasActiveImplementationFlow(ctx: {
  sessionManager: { getBranch: () => Array<{ type: string; customType?: string; data?: unknown }> };
}): boolean {
  const state = loadState(ctx);
  return !!state && state.phase !== "done" && state.phase !== "error";
}

function createState(ticket: Ticket, phase: Phase, autoNext: boolean): ImplementationFlowState {
  return {
    runId: `${Date.now()}-${ticket.id}`,
    phase,
    ticketId: ticket.id,
    featureKey: ticket.feature_key,
    autoNext,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function recordImplementationTicketDone(
  pi: ExtensionAPI,
  ticket: Ticket,
  autoNext = true,
): ImplementationFlowState {
  const state = createState(ticket, "ticketDone", autoNext);
  persist(pi, state);
  return state;
}

export function recordCheckpointHandoffSaved(
  pi: ExtensionAPI,
  ticket: Ticket,
  autoNext = true,
): ImplementationFlowState {
  const state = createState(ticket, "checkpointHandoffSaved", autoNext);
  persist(pi, state);
  return state;
}

function markTicketInProgress(ticket: Ticket): Ticket {
  if (ticket.status !== "pending") return ticket;
  return updateTicket(ticket.id, { status: "in_progress" }) ?? ticket;
}

function buildSameSessionTicketMessage(ticket: Ticket): string {
  return [
    implementationProtocolLine(),
    "",
    `Continue in this same session with ticket #${ticket.id}.`,
    "",
    `## Current ticket #${ticket.id}`,
    formatTicketFull(ticket),
    "",
    compactTicketInstruction(ticket),
  ].join("\n");
}

function buildCheckpointHandoffRequest(ticket: Ticket): string {
  const orderedTickets = listTicketsForSpec(ticket.feature_key);
  const block = getBlockForTicket(orderedTickets, ticket.id);
  if (!ticket.is_checkpoint || !block) return `Checkpoint #${ticket.id} reached.`;

  const nextAfterBlock = getNextTicketAfterBlock(orderedTickets, ticket.id);
  const draft = buildCheckpointHandoffDraft(block.tickets, nextAfterBlock?.id ?? null);
  const nextRecommended = nextAfterBlock ? `#${nextAfterBlock.id}` : "None";

  return [
    `⚠️ CHECKPOINT REACHED — You MUST call \`spec_flow_checkpoint_handoff_save\` as your IMMEDIATE NEXT TOOL CALL.`,
    "",
    "Do NOT write a freeform handoff. Use only evidence from ticket handoffs.",
    "Use empty arrays or \"None\" when evidence is missing.",
    "",
    "Required call:",
    "```",
    `spec_flow_checkpoint_handoff_save(`,
    `  checkpoint_ticket_id: ${ticket.id},`,
    `  feature_key: "${ticket.feature_key}",`,
    `  next_recommended_ticket: "${nextRecommended}",`,
    `  summary: "...",`,
    `  key_outcomes: ["..."],`,
    `  files_changed: ["..."],`,
    `  key_decisions: ["..."],`,
    `  verification: ["..."],`,
    `  open_risks: ["..."] or []`,
    `)`,
    "```",
    "",
    "Block context (use for summary fields):",
    "",
    draft,
  ].join("\n");
}

function complete(state: ImplementationFlowState, pi: ExtensionAPI): void {
  state.phase = "done";
  persist(pi, state);
}

export async function runImplementationFlowEvent(
  pi: ExtensionAPI,
  ctx: any,
  event?: { messages?: any[] },
): Promise<void> {
  const state = loadState(ctx);
  if (!state || state.phase === "done" || state.phase === "error") return;

  if (ctx.hasPendingMessages?.()) {
    ctx.ui.setStatus(STATUS_KEY, `Implementation flow ${state.phase}; waiting for queued messages`);
    return;
  }

  const ticket = getTicket(state.ticketId);
  if (!ticket) {
    state.phase = "error";
    state.lastError = `Ticket #${state.ticketId} not found.`;
    persist(pi, state);
    ctx.ui.notify(state.lastError, "error");
    return;
  }

  if (state.phase === "ticketDone") {
    if (!state.autoNext) {
      complete(state, pi);
      return;
    }

    const orderedTickets = listTicketsForSpec(ticket.feature_key);
    const nextInBlock = getNextTicketInBlock(orderedTickets, ticket.id);

    if (nextInBlock && !ticket.is_checkpoint) {
      const activeNext = markTicketInProgress(nextInBlock);
      pi.sendUserMessage(buildSameSessionTicketMessage(activeNext), { deliverAs: "followUp" });
      ctx.ui.notify(`Queued next ticket #${activeNext.id}.`, "info");
      complete(state, pi);
      return;
    }

    if (ticket.is_checkpoint) {
      pi.sendUserMessage(buildCheckpointHandoffRequest(ticket), { deliverAs: "followUp" });
      state.phase = "checkpointHandoffRequested";
      persist(pi, state);
      return;
    }

    const nextAfterBlock = getNextTicketAfterBlock(orderedTickets, ticket.id);
    if (nextAfterBlock) {
      pi.sendUserMessage(
        `Block ended. Continue with /spec-flow-next --new ${nextAfterBlock.id} --feature=${ticket.feature_key}.`,
        { deliverAs: "followUp" },
      );
    } else {
      ctx.ui.notify("Implementation flow complete. No remaining tickets in this feature.", "info");
    }
    complete(state, pi);
    return;
  }

  if (state.phase === "checkpointHandoffRequested") {
    ctx.ui.setStatus(STATUS_KEY, `Waiting for checkpoint handoff #${ticket.id}`);
    return;
  }

  if (state.phase === "checkpointHandoffSaved") {
    if (!state.autoNext) {
      complete(state, pi);
      return;
    }

    const reviewConfig = getCheckpointReviewConfig();
    if (reviewConfig.enabled && reviewConfig.skills.length > 0) {
      const armedReviewState = armCheckpointReview(pi, ctx, ticket);
      state.phase = "reviewPending";
      persist(pi, state);
      const reviewState = await runCheckpointReviewEvent(pi, ctx, event, armedReviewState);
      if (reviewState?.phase === "reviewRunning") {
        state.phase = "reviewRunning";
        persist(pi, state);
      }
      return;
    }

    const nextAfterBlock = getNextTicketAfterBlock(listTicketsForSpec(ticket.feature_key), ticket.id);
    if (nextAfterBlock) {
      pi.sendUserMessage(
        `Checkpoint handoff saved. Continue with /spec-flow-next --new ${nextAfterBlock.id} --feature=${ticket.feature_key}.`,
        { deliverAs: "followUp" },
      );
    } else {
      ctx.ui.notify("Checkpoint handoff saved. No remaining tickets in this feature.", "info");
    }
    complete(state, pi);
    return;
  }

  if (state.phase === "reviewPending" || state.phase === "reviewRunning") {
    await runCheckpointReviewEvent(pi, ctx, event);
    const reviewState = loadCheckpointReviewState(ctx);
    if (reviewState?.phase === "done") {
      complete(state, pi);
      ctx.ui.notify("Checkpoint review complete. Implementation flow is paused before the next block.", "info");
      return;
    }
    if (reviewState?.phase === "reviewRunning") {
      state.phase = "reviewRunning";
      persist(pi, state);
    }
  }
}
