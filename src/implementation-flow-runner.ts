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
import { runCheckpointReviewSubagent } from "./checkpoint-review-subagent.js";
import { appendDebugLog } from "./debug-log.js";

const STATE_KEY = "spec-flow-implementation-flow";
const COMMAND_CHAIN_KEY = "spec-flow-command-owned-chain";
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

export function recordCommandOwnedImplementationChain(
  pi: ExtensionAPI,
  ticket: Ticket,
): void {
  pi.appendEntry(COMMAND_CHAIN_KEY, {
    ticketId: ticket.id,
    featureKey: ticket.feature_key,
    startedAt: Date.now(),
  });
}

export function appendCommandOwnedImplementationChainToSession(
  sessionManager: { appendCustomEntry: (customType: string, data?: unknown) => unknown },
  ticket: Ticket,
): void {
  sessionManager.appendCustomEntry(COMMAND_CHAIN_KEY, {
    ticketId: ticket.id,
    featureKey: ticket.feature_key,
    startedAt: Date.now(),
  });
}

function hasCommandOwnedImplementationChain(ctx: {
  sessionManager: { getBranch: () => Array<{ type: string; customType?: string; data?: any }> };
}, ticket: Ticket): boolean {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== COMMAND_CHAIN_KEY) continue;
    if (entry.data?.featureKey === ticket.feature_key) return true;
  }
  return false;
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

function formatReviewStartMessage(ticket: Ticket, reviewConfig: ReturnType<typeof getCheckpointReviewConfig>): string {
  const model = reviewConfig.model ?? "Pi default model";
  const thinking = reviewConfig.thinkingLevel ?? "Pi default thinking level";
  return `Starting checkpoint review for #${ticket.id} using model: ${model}; thinking level: ${thinking}.`;
}

export async function runImplementationFlowEvent(
  pi: ExtensionAPI,
  ctx: any,
  event?: { messages?: any[] },
): Promise<void> {
  const state = loadState(ctx);
  appendDebugLog(ctx.cwd, "implementation-flow", "event", {
    phase: state?.phase,
    runId: state?.runId,
    hasPendingMessages: ctx.hasPendingMessages?.(),
    eventMessages: event?.messages?.map((message) => message?.role),
  });
  if (!state || state.phase === "done" || state.phase === "error") return;

  if (ctx.hasPendingMessages?.()) {
    appendDebugLog(ctx.cwd, "implementation-flow", "waiting-pending-messages", {
      phase: state.phase,
      runId: state.runId,
    });
    ctx.ui.setStatus(STATUS_KEY, `Implementation flow ${state.phase}; waiting for queued messages`);
    return;
  }

  const ticket = getTicket(state.ticketId);
  if (!ticket) {
    state.phase = "error";
    state.lastError = `Ticket #${state.ticketId} not found.`;
    persist(pi, state);
    appendDebugLog(ctx.cwd, "implementation-flow", "ticket-not-found", {
      ticketId: state.ticketId,
      runId: state.runId,
    });
    ctx.ui.notify(state.lastError, "error");
    return;
  }

  if (state.phase === "ticketDone") {
    if (!state.autoNext) {
      appendDebugLog(ctx.cwd, "implementation-flow", "auto-next-disabled", {
        runId: state.runId,
        ticketId: ticket.id,
      });
      complete(state, pi);
      return;
    }

    const orderedTickets = listTicketsForSpec(ticket.feature_key);
    const nextInBlock = getNextTicketInBlock(orderedTickets, ticket.id);

    if (nextInBlock && !ticket.is_checkpoint) {
      const activeNext = markTicketInProgress(nextInBlock);
      appendDebugLog(ctx.cwd, "implementation-flow", "queue-next-ticket", {
        runId: state.runId,
        currentTicketId: ticket.id,
        nextTicketId: activeNext.id,
      });
      pi.sendUserMessage(buildSameSessionTicketMessage(activeNext), { deliverAs: "followUp" });
      ctx.ui.notify(`Queued next ticket #${activeNext.id}.`, "info");
      complete(state, pi);
      return;
    }

    if (ticket.is_checkpoint) {
      appendDebugLog(ctx.cwd, "implementation-flow", "queue-checkpoint-handoff-request", {
        runId: state.runId,
        ticketId: ticket.id,
      });
      pi.sendUserMessage(buildCheckpointHandoffRequest(ticket), { deliverAs: "followUp" });
      state.phase = "checkpointHandoffRequested";
      persist(pi, state);
      return;
    }

    const nextAfterBlock = getNextTicketAfterBlock(orderedTickets, ticket.id);
    if (nextAfterBlock) {
      appendDebugLog(ctx.cwd, "implementation-flow", "queue-next-block-command", {
        runId: state.runId,
        ticketId: ticket.id,
        nextTicketId: nextAfterBlock.id,
      });
      pi.sendUserMessage(
        `Block ended. Continue with /spec-flow-next --new ${nextAfterBlock.id} --feature=${ticket.feature_key}.`,
        { deliverAs: "followUp" },
      );
    } else {
      appendDebugLog(ctx.cwd, "implementation-flow", "complete-no-remaining-tickets", {
        runId: state.runId,
        ticketId: ticket.id,
      });
      ctx.ui.notify("Implementation flow complete. No remaining tickets in this feature.", "info");
    }
    complete(state, pi);
    return;
  }

  if (state.phase === "checkpointHandoffRequested") {
    appendDebugLog(ctx.cwd, "implementation-flow", "waiting-checkpoint-handoff", {
      runId: state.runId,
      ticketId: ticket.id,
    });
    ctx.ui.setStatus(STATUS_KEY, `Waiting for checkpoint handoff #${ticket.id}`);
    return;
  }

  if (state.phase === "checkpointHandoffSaved") {
    if (!state.autoNext) {
      appendDebugLog(ctx.cwd, "implementation-flow", "checkpoint-handoff-saved-auto-next-disabled", {
        runId: state.runId,
        ticketId: ticket.id,
      });
      complete(state, pi);
      return;
    }

    const reviewConfig = getCheckpointReviewConfig();
    appendDebugLog(ctx.cwd, "implementation-flow", "checkpoint-handoff-saved", {
      runId: state.runId,
      ticketId: ticket.id,
      reviewEnabled: reviewConfig.enabled,
      reviewModel: reviewConfig.model,
      reviewThinking: reviewConfig.thinkingLevel,
      reviewSkills: reviewConfig.skills,
    });
    if (reviewConfig.enabled && reviewConfig.skills.length > 0) {
      if (hasCommandOwnedImplementationChain(ctx, ticket)) {
        appendDebugLog(ctx.cwd, "implementation-flow", "checkpoint-review-deferred-to-command-chain", {
          runId: state.runId,
          ticketId: ticket.id,
        });
        ctx.ui.notify(
          `Checkpoint handoff saved for #${ticket.id}. Command-owned chain will start fresh code review next.`,
          "info",
        );
        complete(state, pi);
        return;
      }

      state.phase = "reviewRunning";
      persist(pi, state);
      const startMessage = formatReviewStartMessage(ticket, reviewConfig);
      ctx.ui.setStatus(STATUS_KEY, startMessage);
      ctx.ui.notify(startMessage, "info");
      const reviewResult = await runCheckpointReviewSubagent(pi, ctx, ticket);
      appendDebugLog(ctx.cwd, "implementation-flow", "checkpoint-review-subagent-result", {
        runId: state.runId,
        ok: reviewResult.ok,
        exitCode: reviewResult.exitCode,
        reportPath: reviewResult.reportPath,
      });
      const reviewMessage = [
        `Checkpoint review completed for #${ticket.id}.`,
        `Report: ${reviewResult.reportPath}`,
        "",
        "Review flow complete. The extension will not continue implementation or start the next ticket automatically.",
        "FIN. No further action will be taken by spec-flow in this flow.",
        "",
        reviewResult.output.slice(0, 8000),
        reviewResult.output.length > 8000 ? "\n\n[Review output truncated in UI; see report file for full output.]" : "",
      ].join("\n");
      ctx.ui.setWidget("spec-flow-checkpoint-review", reviewMessage.split("\n"));
      ctx.ui.notify(`Checkpoint review completed for #${ticket.id}. Review the UI panel before continuing.`, "info");
      complete(state, pi);
      return;
    }

    const nextAfterBlock = getNextTicketAfterBlock(listTicketsForSpec(ticket.feature_key), ticket.id);
    if (nextAfterBlock) {
      appendDebugLog(ctx.cwd, "implementation-flow", "queue-next-block-after-checkpoint-no-review", {
        runId: state.runId,
        ticketId: ticket.id,
        nextTicketId: nextAfterBlock.id,
      });
      pi.sendUserMessage(
        `Checkpoint handoff saved. Continue with /spec-flow-next --new ${nextAfterBlock.id} --feature=${ticket.feature_key}.`,
        { deliverAs: "followUp" },
      );
    } else {
      appendDebugLog(ctx.cwd, "implementation-flow", "checkpoint-complete-no-remaining-tickets", {
        runId: state.runId,
        ticketId: ticket.id,
      });
      ctx.ui.notify("Checkpoint handoff saved. No remaining tickets in this feature.", "info");
    }
    complete(state, pi);
    return;
  }

  if (state.phase === "reviewPending" || state.phase === "reviewRunning") {
    appendDebugLog(ctx.cwd, "implementation-flow", "review-state-reentered", {
      runId: state.runId,
      phase: state.phase,
    });
    ctx.ui.setStatus(STATUS_KEY, `Checkpoint review subagent running for #${ticket.id}`);
  }
}
