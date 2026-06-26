/**
 * /spec-flow-checkpoint-review command — opens a fresh review session
 * for a checkpoint using only tickets and checkpoint handoff context.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  initTicketsStore,
  listTicketsForSpec,
  getTicket,
  getCheckpointReviewConfig,
} from "../tickets-fs.js";
import { getNextTicketAfterBlock } from "../checkpoints.js";
import {
  buildCheckpointReviewSystemPrompt,
  buildCheckpointReviewTask,
  loadCheckpointReviewSkillInstructions,
} from "../checkpoint-review-subagent.js";
import { appendDebugLog } from "../debug-log.js";
import {
  parseCheckpointReviewCommandArgs,
  resolveReviewModel,
} from "./command-helpers.js";

export async function startFreshCheckpointReviewSession(
  pi: ExtensionAPI,
  args: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<void> {
  initTicketsStore(ctx.cwd);
  const parsed = parseCheckpointReviewCommandArgs(args);
  if (parsed.ticketId == null) {
    ctx.ui.notify("Usage: /spec-flow-checkpoint-review <checkpoint-ticket-id> [--feature feature-key]", "error");
    return;
  }

  const ticket = getTicket(parsed.ticketId);
  if (!ticket) {
    ctx.ui.notify(`Checkpoint ticket #${parsed.ticketId} not found.`, "error");
    return;
  }
  if (parsed.feature && ticket.feature_key !== parsed.feature) {
    ctx.ui.notify(`Ticket #${ticket.id} belongs to "${ticket.feature_key}", not "${parsed.feature}".`, "error");
    return;
  }
  if (!ticket.is_checkpoint) {
    ctx.ui.notify(`Ticket #${ticket.id} is not a checkpoint ticket.`, "error");
    return;
  }

  const reviewConfig = getCheckpointReviewConfig();
  if (!reviewConfig.enabled || reviewConfig.skills.length === 0) {
    ctx.ui.notify("Checkpoint review is not enabled or has no review skills configured.", "warning");
    return;
  }

  const selectedModel = resolveReviewModel(ctx, reviewConfig.model);
  const isReplacementContext = typeof (ctx as unknown as { sendUserMessage?: unknown }).sendUserMessage === "function";

  const skillInstructions = loadCheckpointReviewSkillInstructions(reviewConfig.skills, ctx.cwd);
  const reviewPrompt = [
    buildCheckpointReviewSystemPrompt(skillInstructions),
    "",
    "---",
    "",
    "You are starting from a fresh session on purpose.",
    "Do not use or request the implementation conversation. Treat this as an independent third-party code review.",
    "Use only the repository state, the tickets, and the checkpoint handoff included below.",
    "Do not modify files. Do not continue implementation. Do not start the next ticket. End after the review.",
    "",
    buildCheckpointReviewTask(ticket, ctx.cwd),
  ].join("\n");

  appendDebugLog(ctx.cwd, "checkpoint-review-fresh-session", "start", {
    ticketId: ticket.id,
    featureKey: ticket.feature_key,
    configuredModel: reviewConfig.model,
    selectedModel: selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : undefined,
    thinking: reviewConfig.thinkingLevel,
    skills: reviewConfig.skills,
  });

  if (selectedModel && !isReplacementContext) {
    const switched = await pi.setModel(selectedModel);
    if (!switched) {
      ctx.ui.notify(`Failed to switch to review model ${selectedModel.provider}/${selectedModel.id}.`, "error");
      return;
    }
  } else if (selectedModel && isReplacementContext) {
    ctx.ui.notify(
      `Review model ${selectedModel.provider}/${selectedModel.id} is configured, but this review is being launched from a replacement session; using the current model to avoid stale ExtensionAPI calls.`,
      "warning",
    );
  } else if (reviewConfig.model) {
    ctx.ui.notify(`No available configured review model from: ${reviewConfig.model}. Using current model.`, "warning");
  }

  if (reviewConfig.thinkingLevel && !isReplacementContext) {
    pi.setThinkingLevel(reviewConfig.thinkingLevel as any);
  } else if (reviewConfig.thinkingLevel && isReplacementContext) {
    ctx.ui.notify(
      `Review thinking level ${reviewConfig.thinkingLevel} is configured, but this review is being launched from a replacement session; using the current thinking level.`,
      "warning",
    );
  }

  const currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
  const result = await ctx.newSession({
    parentSession: currentSessionFile,
    withSession: async (reviewCtx) => {
      // ReplacedSessionContext.sendUserMessage is async and resolves after the
      // review turn has fully completed. Do not call waitForTurnStart() after
      // awaiting it; by then the turn is already over and the command would
      // wait forever, leaving the TUI apparently hung.
      await reviewCtx.sendUserMessage(reviewPrompt);

      const orderedTickets = listTicketsForSpec(ticket.feature_key);
      const nextAfterBlock = getNextTicketAfterBlock(orderedTickets, ticket.id);
      const nextHint = nextAfterBlock
        ? `To continue implementation, start a new session:\n  /spec-flow-next --new ${nextAfterBlock.id} --feature=${ticket.feature_key}`
        : "No remaining tickets in this feature. Implementation is complete.";

      reviewCtx.ui.notify(
        [
          `Checkpoint review completed for #${ticket.id}.`,
          "This session intentionally did not inherit implementation context.",
          "",
          "Review the output above before continuing.",
          nextHint,
        ].join("\n"),
        "info",
      );
    },
  });

  if (result.cancelled) {
    ctx.ui.notify("Fresh checkpoint review session cancelled.", "warning");
  }
}

export function registerCheckpointReviewCommand(pi: ExtensionAPI): void {
  pi.registerCommand("spec-flow-checkpoint-review", {
    description:
      "Open a fresh review session for a checkpoint using only tickets and checkpoint handoff context",
    handler: async (args, ctx) => {
      await startFreshCheckpointReviewSession(pi, args, ctx);
    },
  });
}
