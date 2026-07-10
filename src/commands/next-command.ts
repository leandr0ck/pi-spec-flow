/**
 * /spec-flow-next, /spec-flow-implement, /spec-flow-start commands
 * — start implementation block-by-block until each checkpoint.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  initTicketsStore,
  ticketsExist,
  listTickets,
  listTicketsForSpec,
  getTicket,
  getCheckpointReviewConfig,
  type Ticket,
} from "../tickets-fs.js";
import { getBlockForTicket, getPreviousCheckpointTicket, isFirstTicketOfBlock } from "../checkpoints.js";
import { loadCheckpointHandoff, loadPreviousCheckpointHandoff } from "../checkpoint-handoffs.js";
import { buildTicketKickoffMessage, buildBlockKickoffMessage } from "../prompt-builders.js";
import { loadPlanningContext, loadPlanningContextBySpecPath } from "../planning-context.js";
import {
  appendCommandOwnedImplementationChainToSession,
  recordCommandOwnedImplementationChain,
} from "../implementation-flow-runner.js";
import {
  parseSpecFlowNextArgs,
  markTicketInProgress,
  resolveFeatureSpec,
  sendUserMessageAndWait,
  toStoredSpecPath,
} from "./command-helpers.js";
import { startFreshCheckpointReviewSession } from "./checkpoint-review-command.js";

export function registerNextCommand(pi: ExtensionAPI): void {
  // ── /spec-flow-next ───────────────────────────────────────

  pi.registerCommand("spec-flow-next", {
    description:
      "Show next pending (or ID), optionally scoped by spec path or --feature; use --new for fresh session",
    handler: async (args, ctx) => {
      await startImplementationByTicket(pi, args, ctx);
    },
  });

  // ── /spec-flow-implement ────────────────────────────────

  pi.registerCommand("spec-flow-implement", {
    description:
      "Start implementation block-by-block until each checkpoint (pass a spec path in spec-local ticket mode)",
    handler: async (args, ctx) => {
      await startImplementationByTicket(pi, args, ctx);
    },
  });

  // Backward-safe alias for a simpler UX
  pi.registerCommand("spec-flow-start", {
    description: "Alias of /spec-flow-implement",
    handler: async (args, ctx) => {
      await startImplementationByTicket(pi, args, ctx);
    },
  });
}

async function confirmSelectedImplementationTicket(
  ticket: Ticket,
  ctx: ExtensionCommandContext
): Promise<boolean> {
  ctx.ui.notify(
    `Selected ticket: #${ticket.id} — ${ticket.title} (${ticket.feature_key})`,
    "info"
  );

  const choice = await ctx.ui.select("Proceed with this ticket?", [
    "Yes, proceed",
    "No, cancel",
  ]);

  return choice === "Yes, proceed";
}

async function startImplementationByTicket(
  pi: ExtensionAPI,
  args: string | undefined,
  ctx: ExtensionCommandContext
): Promise<void> {
  const parsed = parseSpecFlowNextArgs(args);
  let requestedSpecPath: string | null = null;
  if (parsed.specPath) {
    const absoluteSpecPath = resolve(ctx.cwd, parsed.specPath);
    if (!existsSync(absoluteSpecPath)) {
      ctx.ui.notify(`Spec file not found: ${absoluteSpecPath}`, "error");
      return;
    }
    requestedSpecPath = toStoredSpecPath(ctx.cwd, absoluteSpecPath);
  }

  const featureContext = parsed.feature ? loadPlanningContext(ctx.cwd, parsed.feature) : null;
  const specContext = requestedSpecPath ? loadPlanningContextBySpecPath(ctx.cwd, requestedSpecPath) : null;
  initTicketsStore(ctx.cwd, {
    sourceSpecPath: requestedSpecPath ?? featureContext?.sourceSpecPath ?? null,
    ticketsFolder: specContext?.ticketsFolder ?? featureContext?.ticketsFolder ?? null,
    ticketsFolderBase: specContext?.ticketsFolderBase ?? featureContext?.ticketsFolderBase ?? null,
  });
  if (!ticketsExist()) {
    ctx.ui.notify("No tickets store. Run /spec-flow-init first.", "warning");
    return;
  }

  const all = listTickets();
  if (all.length === 0) {
    ctx.ui.notify("No tickets found.", "info");
    return;
  }

  // Resolve feature early so we can scope validation
  const availableSpecs = Array.from(new Set(all.map((t) => t.feature_key))).sort();
  const resolvedFeature = resolveFeatureSpec(parsed.feature, availableSpecs);

  if (parsed.feature && !resolvedFeature) {
    ctx.ui.notify(
      `Feature/spec not found: "${parsed.feature}". Available: ${availableSpecs.join(", ")}`,
      "error"
    );
    return;
  }

  // When --feature is specified, only validate tickets for that feature
  const ticketsToValidate = resolvedFeature
    ? listTicketsForSpec(resolvedFeature)
    : all;
  const requiredIssues = ticketsToValidate.filter(
    (t) => !t.acceptance_criteria || !t.verification || !t.estimated_scope || !t.phase
  );

  if (requiredIssues.length > 0) {
    const sample = requiredIssues
      .slice(0, 5)
      .map((t) => `#${t.id} ${t.title}`)
      .join("\n");
    ctx.ui.notify(
      [
        "Some tickets are incomplete. Review/fix before implementation:",
        sample,
        requiredIssues.length > 5 ? `... and ${requiredIssues.length - 5} more` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      "warning"
    );
    return;
  }

  let ticket: Ticket | undefined;

  if (parsed.ticketId != null) {
    ticket = getTicket(parsed.ticketId) || undefined;
    if (!ticket) {
      ctx.ui.notify(`Ticket #${parsed.ticketId} not found.`, "error");
      return;
    }

    if (resolvedFeature && ticket.feature_key !== resolvedFeature) {
      ctx.ui.notify(
        `Ticket #${ticket.id} belongs to "${ticket.feature_key}", not "${resolvedFeature}".`,
        "error"
      );
      return;
    }
  } else {
    const unfinishedSpecs = Array.from(
      new Set(all.filter((t) => t.status !== "done").map((t) => t.feature_key))
    ).sort();

    if (unfinishedSpecs.length === 0) {
      ctx.ui.notify("All tickets are done. Nothing to implement.", "info");
      return;
    }

    let targetSpec: string | undefined;

    if (resolvedFeature) {
      targetSpec = resolvedFeature;
    } else if (unfinishedSpecs.length === 1) {
      targetSpec = unfinishedSpecs[0];
    } else {
      const choice = await ctx.ui.select(
        "Which feature/spec do you want to implement?",
        unfinishedSpecs
      );
      if (!choice) {
        ctx.ui.notify("Implementation cancelled (no feature selected).", "warning");
        return;
      }
      targetSpec = choice;
    }

    const inProgress = listTicketsForSpec(targetSpec, "in_progress");
    const pending = listTicketsForSpec(targetSpec, "pending");
    ticket = inProgress[0] || pending[0];
  }

  if (!ticket) {
    ctx.ui.notify("No ticket available for the selected feature.", "info");
    return;
  }

  const confirmed = await confirmSelectedImplementationTicket(ticket, ctx);
  if (!confirmed) {
    ctx.ui.notify("Implementation cancelled by user.", "warning");
    return;
  }

  const scoped = listTicketsForSpec(ticket.feature_key);
  const done = scoped.filter((t) => t.status === "done").length;
  const inProgressCount = scoped.filter((t) => t.status === "in_progress").length;
  const pendingCount = scoped.filter((t) => t.status === "pending").length;

  const previousHandoff = isFirstTicketOfBlock(scoped, ticket.id)
    ? loadPreviousCheckpointHandoff(ctx.cwd, scoped, ticket.id)?.content ?? null
    : null;
  const previousCheckpoint = isFirstTicketOfBlock(scoped, ticket.id)
    ? getPreviousCheckpointTicket(scoped, ticket.id) ?? null
    : null;

  if (previousCheckpoint && !previousHandoff) {
    ctx.ui.notify(
      `Checkpoint handoff for #${previousCheckpoint.id} is missing. Complete that summary before opening the next block.`,
      "warning"
    );
    return;
  }

  const activeTicket = markTicketInProgress(ticket);
  const activeScoped = listTicketsForSpec(activeTicket.feature_key);
  const activeBlock = getBlockForTicket(activeScoped, activeTicket.id);
  const checkpointTicket = activeBlock?.checkpointTicket ?? null;

  const kickoff = buildBlockKickoffMessage(activeTicket, activeScoped, previousHandoff, {
    done,
    inProgress: inProgressCount,
    pending: pendingCount,
    total: scoped.length,
  });

  // Helper function to run implementation + review in a session context
  const runImplementationAndReview = async (
    sessionCtx: ExtensionCommandContext,
    options: { commandChainAlreadyRecorded?: boolean } = {},
  ) => {
    if (!options.commandChainAlreadyRecorded) {
      recordCommandOwnedImplementationChain(pi, activeTicket);
    }
    sessionCtx.ui.notify(
      `Implementation chain started on ticket #${activeTicket.id}: ${activeTicket.title}`,
      "info",
    );
    await sendUserMessageAndWait(pi, sessionCtx, kickoff);

    if (!checkpointTicket) {
      sessionCtx.ui.notify("Implementation chain reached idle; no checkpoint ticket was found for this block.", "info");
      return;
    }

    const completedCheckpoint = getTicket(checkpointTicket.id);
    const savedHandoff = completedCheckpoint
      ? loadCheckpointHandoff(sessionCtx.cwd, completedCheckpoint.feature_key, completedCheckpoint.id)
      : null;

    if (!completedCheckpoint || completedCheckpoint.status !== "done" || !savedHandoff) {
      sessionCtx.ui.notify(
        `Implementation chain reached idle before checkpoint #${checkpointTicket.id} was fully closed and handed off. No review started.`,
        "warning",
      );
      return;
    }

    const reviewConfig = getCheckpointReviewConfig();
    if (!reviewConfig.enabled || reviewConfig.skills.length === 0) {
      sessionCtx.ui.notify(`Checkpoint #${completedCheckpoint.id} complete. Review is disabled; chain stops here.`, "info");
      return;
    }

    await startFreshCheckpointReviewSession(
      pi,
      `${completedCheckpoint.id} --feature=${completedCheckpoint.feature_key}`,
      sessionCtx,
    );
  };

  if (parsed.openInNewSession) {
    await ctx.newSession({
      parentSession: ctx.sessionManager.getSessionFile() ?? undefined,
      setup: async (sessionManager) => {
        appendCommandOwnedImplementationChainToSession(sessionManager, activeTicket);
      },
      withSession: async (newSessionCtx) => {
        await runImplementationAndReview(newSessionCtx, { commandChainAlreadyRecorded: true });
      },
    });
  } else {
    await runImplementationAndReview(ctx);
  }
}
