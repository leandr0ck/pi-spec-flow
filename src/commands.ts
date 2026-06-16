/**
 * spec-flow commands — /spec-flow-init, /spec-flow-next, /spec-flow-implement
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolve, basename, relative, isAbsolute } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import {
  initTicketsStore,
  ticketsExist,
  ticketCountForSpec,
  clearTicketsForSpec,
  listTickets,
  listTicketsForSpec,
  getTicket,
  updateTicket,
  getCheckpointReviewConfig,
  type Ticket,
} from "./tickets-fs.js";
import { formatTicketFull } from "./formatters.js";
import { parseSpecSections, buildSpecSummary } from "./spec-parser.js";
import { loadMethodology } from "./methodology-loader.js";
import { getBlockForTicket, getPreviousCheckpointTicket, isFirstTicketOfBlock } from "./checkpoints.js";
import { loadCheckpointHandoff, loadPreviousCheckpointHandoff } from "./checkpoint-handoffs.js";
import { savePlanningContext } from "./planning-context.js";
import { compactTicketInstruction, implementationProtocolLine } from "./prompt-builders.js";
import {
  buildCheckpointReviewSystemPrompt,
  buildCheckpointReviewTask,
  loadCheckpointReviewSkillInstructions,
} from "./checkpoint-review-subagent.js";
import { appendDebugLog } from "./debug-log.js";
import { recordCommandOwnedImplementationChain } from "./implementation-flow-runner.js";

type SpecFlowInitArgs = {
  specArg: string;
  featureName: string | null;
};

function normalizeFeatureName(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled-feature"
  );
}

function suggestFeatureNameFromSpec(content: string, specFile: string): string {
  const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (h1) return normalizeFeatureName(h1);

  const firstNonEmpty = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);

  if (firstNonEmpty) {
    return normalizeFeatureName(firstNonEmpty.replace(/^#+\s*/, ""));
  }

  return normalizeFeatureName(specFile.replace(/\.md$/i, ""));
}

function parseSpecFlowInitArgs(rawArgs?: string): SpecFlowInitArgs | null {
  if (!rawArgs || !rawArgs.trim()) return null;

  const tokens = rawArgs.trim().split(/\s+/);
  let specArg: string | null = null;
  let featureName: string | null = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;

    if (token.startsWith("--feature=")) {
      featureName = token.slice("--feature=".length).trim() || null;
      continue;
    }

    if (token === "--feature" && i + 1 < tokens.length) {
      featureName = tokens[i + 1].trim() || null;
      i += 1;
      continue;
    }

    if (!token.startsWith("-") && !specArg) {
      specArg = token;
    }
  }

  if (!specArg) return null;
  return { specArg, featureName };
}

function toStoredSpecPath(cwd: string, specPath: string): string {
  const rel = relative(cwd, specPath);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
    return rel;
  }
  return specPath;
}

function markTicketInProgress(ticket: Ticket): Ticket {
  if (ticket.status !== "pending") return ticket;
  return updateTicket(ticket.id, { status: "in_progress" }) ?? ticket;
}

// ── Command registration ────────────────────────────────────

export function registerCommands(pi: ExtensionAPI): void {
  // ── /spec-flow-init ───────────────────────────────────────

  pi.registerCommand("spec-flow-init", {
    description:
      "Read a spec and guide LLM to create structured tickets following planning methodology",
    getArgumentCompletions: (prefix: string) => {
      try {
        const files = readdirSync(process.cwd())
          .filter((f: string) => f.endsWith(".md"))
          .map((f: string) => ({
            value: f,
            label: f,
            description: "Markdown spec file",
          }));
        const filtered = prefix
          ? files.filter((f: { value: string }) => f.value.startsWith(prefix))
          : files;
        return filtered.length > 0 ? filtered : null;
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      const parsedInit = parseSpecFlowInitArgs(args);
      if (!parsedInit) {
        ctx.ui.notify("Usage: /spec-flow-init <path-to-spec.md> [--feature \"feature-name\"]", "error");
        return;
      }

      const normalizedArgs = parsedInit.specArg.trim().replace(/^@+/, "");
      const specPath = resolve(ctx.cwd, normalizedArgs);
      let content: string;
      try {
        ctx.ui.notify("Reading spec internally...", "info");
        content = readFileSync(specPath, "utf-8");
      } catch {
        ctx.ui.notify(`Cannot read file: ${specPath}`, "error");
        return;
      }

      const specFile = basename(specPath);
      let featureName = parsedInit.featureName
        ? normalizeFeatureName(parsedInit.featureName)
        : suggestFeatureNameFromSpec(content, specFile);

      if (!parsedInit.featureName) {
        const confirmed = await ctx.ui.confirm(
          "Confirm feature name",
          `No --feature flag provided. Suggested from spec title: "${featureName}". Use this name?`
        );

        if (!confirmed) {
          ctx.ui.notify(
            "Init cancelled. Re-run with --feature \"feature-name\".",
            "info"
          );
          return;
        }
      }
      const { sections } = parseSpecSections(content);
      const storedSpecPath = toStoredSpecPath(ctx.cwd, specPath);

      if (sections.length === 0) {
        ctx.ui.notify(
          "No '##' sections found in spec. Nothing to ticket-ify.",
          "warning"
        );
        return;
      }

      // Init tickets store
      initTicketsStore(ctx.cwd);
      savePlanningContext(ctx.cwd, featureName, storedSpecPath);

      // Clear existing tickets if user confirms
      const existingCount = ticketCountForSpec(featureName);
      if (existingCount > 0) {
        const replace = await ctx.ui.confirm(
          "Tickets exist",
          `${existingCount} ticket(s) already exist for feature "${featureName}". Replace them?`
        );
        if (!replace) {
          ctx.ui.notify(
            "Init cancelled — existing tickets preserved.",
            "info"
          );
          return;
        }
        clearTicketsForSpec(featureName);
      }

      // Send the spec + planning methodology to the LLM as hidden context.
      // This keeps the TUI compact while preserving the full planning input.
      ctx.ui.notify("Loading planning methodology internally...", "info");
      const summary = buildSpecSummary(content, specFile);
      const msg = [
        summary,
        "",
        "---",
        "",
        loadMethodology(),
        "",
        "**Your task — create and validate tickets one at a time:**",
        "",
        "1. Create ticket #1 using `spec_flow_create`. Start with Foundation phase.",
        "2. Stop after each `spec_flow_create`. The extension validates the created ticket automatically after the turn.",
        "3. If validation passes, the extension will tell you to create the next ticket. Repeat until all tickets are created.",
        "4. If validation fails, the extension will send a fix checklist. **Re-read the source spec document** if needed, then use `spec_flow_update` to fix only the failing fields. The extension will re-validate automatically.",
        "5. After ALL tickets pass individually, run `spec_flow_validate_tickets` for cross-cutting checks.",
        "",
        "Create Foundation phase tickets first, then Core Features, then Polish. Add checkpoint tickets every 2-3 tasks and at phase boundaries.",
        `Use feature_key: "${featureName}" for all tickets (this is the feature key/folder).`,
        `Use source_spec_path: "${storedSpecPath}" for all tickets (this is the real spec file path).`,
        `Spec source file loaded: "${specFile}".`,
        "",
        "Every ticket MUST have: acceptance_criteria, verification, estimated_scope (XS/S/M/L), phase, and source_spec_path.",
      ].join("\n");

      pi.sendMessage(
        {
          customType: "spec-flow-init",
          content: msg,
          display: false,
          details: { specFile, featureName, sections: sections.length },
        },
        { triggerTurn: true },
      );
      ctx.ui.notify(
        `Loaded spec "${specFile}" for feature "${featureName}" (${sections.length} sections). Creating tickets...`,
        "info"
      );
    },
  });

  // ── /spec-flow-next ───────────────────────────────────────

  pi.registerCommand("spec-flow-next", {
    description:
      "Show next pending (or ID), optionally scoped by --feature; use --new for fresh session",
    handler: async (args, ctx) => {
      initTicketsStore(ctx.cwd);
      if (!ticketsExist()) {
        ctx.ui.notify(
          "No tickets store. Run /spec-flow-init first.",
          "warning"
        );
        return;
      }

      const parsed = parseSpecFlowNextArgs(args);
      let ticket: Ticket | undefined;
      const all = listTickets();
      const availableSpecs = Array.from(new Set(all.map((t) => t.feature_key))).sort();
      const resolvedFeature = resolveFeatureSpec(parsed.feature, availableSpecs);

      if (parsed.feature && !resolvedFeature) {
        ctx.ui.notify(
          `Feature/spec not found: "${parsed.feature}". Available: ${availableSpecs.join(", ")}`,
          "error"
        );
        return;
      }

      if (parsed.ticketId != null) {
        const byId = getTicket(parsed.ticketId);
        if (!byId) {
          ctx.ui.notify(`Ticket #${parsed.ticketId} not found.`, "error");
          return;
        }
        if (resolvedFeature && byId.feature_key !== resolvedFeature) {
          ctx.ui.notify(
            `Ticket #${byId.id} belongs to "${byId.feature_key}", not "${resolvedFeature}".`,
            "error"
          );
          return;
        }
        ticket = byId;
      } else {
        const pending = resolvedFeature
          ? listTicketsForSpec(resolvedFeature, "pending")
          : listTickets("pending");
        if (pending.length === 0) {
          const inProgress = resolvedFeature
            ? listTicketsForSpec(resolvedFeature, "in_progress")
            : listTickets("in_progress");
          if (inProgress.length > 0) {
            ctx.ui.notify(
              `${inProgress.length} ticket(s) in progress, none pending.`,
              "info"
            );
          } else {
            ctx.ui.notify("All tickets done!", "info");
          }
          return;
        }
        ticket = pending[0];
      }

      if (!ticket) {
        ctx.ui.notify("No ticket found.", "warning");
        return;
      }

      const orderedTickets = listTicketsForSpec(ticket.feature_key);
      const previousHandoff = isFirstTicketOfBlock(orderedTickets, ticket.id)
        ? loadPreviousCheckpointHandoff(ctx.cwd, orderedTickets, ticket.id)?.content ?? null
        : null;
      const previousCheckpoint = isFirstTicketOfBlock(orderedTickets, ticket.id)
        ? getPreviousCheckpointTicket(orderedTickets, ticket.id) ?? null
        : null;

      if (previousCheckpoint && !previousHandoff) {
        ctx.ui.notify(
          `Checkpoint handoff for #${previousCheckpoint.id} is missing. Complete that summary before opening the next block.`,
          "warning"
        );
        return;
      }

      const activeTicket = markTicketInProgress(ticket);
      const activeOrderedTickets = listTicketsForSpec(activeTicket.feature_key);

      if (!parsed.openInNewSession) {
        pi.sendUserMessage(
          previousHandoff
            ? [
                implementationProtocolLine(),
                "",
                "Read this synthesized handoff from the previous checkpoint first:",
                "",
                previousHandoff,
                "",
                `## Current ticket #${activeTicket.id}`,
                formatTicketFull(activeTicket),
                "",
                compactTicketInstruction(activeTicket),
              ].join("\n")
            : buildTicketKickoffMessage(activeTicket)
        );
        ctx.ui.notify(`Sent ticket #${activeTicket.id}: ${activeTicket.title}`, "info");
        return;
      }

      const kickoff = buildBlockKickoffMessage(activeTicket, activeOrderedTickets, previousHandoff);
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile() ?? undefined,
        withSession: async (newSessionCtx) => {
          await newSessionCtx.sendUserMessage(kickoff);
          newSessionCtx.ui.notify(
            `Opened new session for ticket #${activeTicket.id}: ${activeTicket.title}`,
            "info"
          );
        },
      });
    },
  });

  // ── /spec-flow-implement ────────────────────────────────

  pi.registerCommand("spec-flow-implement", {
    description:
      "Start implementation block-by-block until each checkpoint (select feature if multiple, or pass --feature)",
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

  // ── /spec-flow-checkpoint-review ────────────────────────

  pi.registerCommand("spec-flow-checkpoint-review", {
    description:
      "Open a fresh review session for a checkpoint using only tickets and checkpoint handoff context",
    handler: async (args, ctx) => {
      await startFreshCheckpointReviewSession(pi, args, ctx);
    },
  });
}

type CheckpointReviewCommandArgs = {
  ticketId: number | null;
  feature: string | null;
};

function parseCheckpointReviewCommandArgs(rawArgs?: string): CheckpointReviewCommandArgs {
  if (!rawArgs || rawArgs.trim().length === 0) return { ticketId: null, feature: null };

  const tokens = rawArgs.trim().split(/\s+/);
  let ticketId: number | null = null;
  let feature: string | null = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;

    if (token.startsWith("--feature=")) {
      feature = token.slice("--feature=".length).trim() || null;
      continue;
    }

    if (token === "--feature" && i + 1 < tokens.length) {
      feature = tokens[i + 1].trim() || null;
      i += 1;
      continue;
    }

    if (/^\d+$/.test(token)) {
      ticketId = Number(token);
    }
  }

  return { ticketId, feature };
}

function resolveReviewModel(ctx: ExtensionCommandContext, configuredModel: string | undefined): any | undefined {
  if (!configuredModel?.trim()) return undefined;
  const candidates = configuredModel
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean);

  const available = ctx.modelRegistry.getAvailable();
  const providerPriority = ["openai-codex", "anthropic", "github-copilot", "openrouter", "openai"];

  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      const [provider, ...modelParts] = candidate.split("/");
      const modelId = modelParts.join("/");
      const model = available.find((entry: any) => entry.provider === provider && entry.id === modelId)
        ?? ctx.modelRegistry.find(provider, modelId);
      if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return model;
      continue;
    }

    const matches = available.filter((entry: any) => entry.id === candidate);
    matches.sort((a: any, b: any) => {
      const aIndex = providerPriority.indexOf(a.provider);
      const bIndex = providerPriority.indexOf(b.provider);
      return (aIndex < 0 ? 999 : aIndex) - (bIndex < 0 ? 999 : bIndex);
    });
    if (matches[0]) return matches[0];
  }

  return undefined;
}

async function startFreshCheckpointReviewSession(
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
  const originalTools = pi.getActiveTools();
  const readOnlyTools = ["read", "grep", "find", "ls", "bash"].filter((tool) =>
    pi.getAllTools().some((availableTool) => availableTool.name === tool),
  );

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

  if (selectedModel) {
    const switched = await pi.setModel(selectedModel);
    if (!switched) {
      ctx.ui.notify(`Failed to switch to review model ${selectedModel.provider}/${selectedModel.id}.`, "error");
      return;
    }
  } else if (reviewConfig.model) {
    ctx.ui.notify(`No available configured review model from: ${reviewConfig.model}. Using current model.`, "warning");
  }

  if (reviewConfig.thinkingLevel) {
    pi.setThinkingLevel(reviewConfig.thinkingLevel as any);
  }
  if (readOnlyTools.length > 0) {
    pi.setActiveTools(readOnlyTools);
  }

  const currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
  const result = await ctx.newSession({
    parentSession: currentSessionFile,
    withSession: async (reviewCtx) => {
      await reviewCtx.sendUserMessage(reviewPrompt);
      await waitForTurnStart(reviewCtx);
      await reviewCtx.waitForIdle();
      reviewCtx.ui.notify(
        `Fresh checkpoint review completed for #${ticket.id}. This session intentionally did not inherit implementation context.`,
        "info",
      );
    },
  });

  if (result.cancelled) {
    pi.setActiveTools(originalTools);
    ctx.ui.notify("Fresh checkpoint review session cancelled.", "warning");
  }
}

type SpecFlowNextArgs = {
  ticketId: number | null;
  openInNewSession: boolean;
  feature: string | null;
};

function parseSpecFlowNextArgs(rawArgs?: string): SpecFlowNextArgs {
  if (!rawArgs || rawArgs.trim().length === 0) {
    return { ticketId: null, openInNewSession: false, feature: null };
  }

  const tokens = rawArgs.trim().split(/\s+/);
  let ticketId: number | null = null;
  let openInNewSession = false;
  let feature: string | null = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (["--new", "-n", "--new-session", "--task"].includes(token)) {
      openInNewSession = true;
      continue;
    }

    if (token.startsWith("--feature=")) {
      feature = token.slice("--feature=".length).trim() || null;
      continue;
    }

    if (token === "--feature" && i + 1 < tokens.length) {
      feature = tokens[i + 1].trim() || null;
      i += 1;
      continue;
    }

    if (/^\d+$/.test(token)) {
      ticketId = Number(token);
      continue;
    }

    if (!token.startsWith("-")) {
      feature = token;
    }
  }

  return { ticketId, openInNewSession, feature };
}

function specAlias(specFile: string): string {
  return specFile.toLowerCase().replace(/\.md$/i, "");
}

function resolveFeatureSpec(
  featureInput: string | null,
  availableSpecs: string[]
): string | null {
  if (!featureInput) return null;

  const raw = featureInput.trim();
  if (!raw) return null;

  const exact = availableSpecs.find((s) => s === raw);
  if (exact) return exact;

  const rawAlias = specAlias(raw);
  const byAlias = availableSpecs.filter((s) => specAlias(s) === rawAlias);
  if (byAlias.length === 1) return byAlias[0];

  const byPrefix = availableSpecs.filter((s) => specAlias(s).startsWith(rawAlias));
  if (byPrefix.length === 1) return byPrefix[0];

  return null;
}

function buildTicketKickoffMessage(ticket: Ticket): string {
  return [
    implementationProtocolLine(),
    "",
    `## Current ticket #${ticket.id}`,
    formatTicketFull(ticket),
    "",
    compactTicketInstruction(ticket),
  ].join("\n");
}

function buildBlockKickoffMessage(
  ticket: Ticket,
  orderedTickets: Ticket[],
  previousCheckpointHandoff: string | null,
  progress?: {
    done: number;
    inProgress: number;
    pending: number;
    total: number;
  },
): string {
  const block = getBlockForTicket(orderedTickets, ticket.id);
  if (!block) {
    return buildTicketKickoffMessage(ticket);
  }

  const ticketList = block.tickets.map((entry) => `#${entry.id}`).join(", ");
  const checkpointLabel = block.checkpointTicket
    ? `#${block.checkpointTicket.id}`
    : "implicit final checkpoint";

  return [
    implementationProtocolLine(),
    `Block ${ticketList} until checkpoint ${checkpointLabel}.`,
    previousCheckpointHandoff
      ? ["", "Previous checkpoint handoff:", "", previousCheckpointHandoff].join("\n")
      : null,
    "",
    `## Current ticket #${ticket.id}`,
    formatTicketFull(ticket),
    "",
    compactTicketInstruction(ticket),
  ]
    .filter(Boolean)
    .join("\n");
}

async function waitForTurnStart(ctx: { isIdle: () => boolean }): Promise<void> {
  while (ctx.isIdle()) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForQueuedTurnsToDrain(ctx: ExtensionCommandContext): Promise<void> {
  while (ctx.hasPendingMessages()) {
    if (ctx.isIdle()) await waitForTurnStart(ctx);
    await ctx.waitForIdle();
  }
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
  initTicketsStore(ctx.cwd);
  if (!ticketsExist()) {
    ctx.ui.notify("No tickets store. Run /spec-flow-init first.", "warning");
    return;
  }

  const all = listTickets();
  if (all.length === 0) {
    ctx.ui.notify("No tickets found.", "info");
    return;
  }

  const requiredIssues = all.filter(
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

  const parsed = parseSpecFlowNextArgs(args);
  let ticket: Ticket | undefined;
  const availableSpecs = Array.from(new Set(all.map((t) => t.feature_key))).sort();

  const resolvedFeature = resolveFeatureSpec(parsed.feature, availableSpecs);

  if (parsed.feature && !resolvedFeature) {
    ctx.ui.notify(
      `Feature/spec not found: "${parsed.feature}". Available: ${availableSpecs.join(", ")}`,
      "error"
    );
    return;
  }

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

  recordCommandOwnedImplementationChain(pi, activeTicket);
  ctx.ui.notify(
    `Implementation chain started on ticket #${activeTicket.id}: ${activeTicket.title}`,
    "info",
  );
  pi.sendUserMessage(kickoff);
  await waitForTurnStart(ctx);
  await ctx.waitForIdle();
  await waitForQueuedTurnsToDrain(ctx);

  if (!checkpointTicket) {
    ctx.ui.notify("Implementation chain reached idle; no checkpoint ticket was found for this block.", "info");
    return;
  }

  const completedCheckpoint = getTicket(checkpointTicket.id);
  const savedHandoff = completedCheckpoint
    ? loadCheckpointHandoff(ctx.cwd, completedCheckpoint.feature_key, completedCheckpoint.id)
    : null;

  if (!completedCheckpoint || completedCheckpoint.status !== "done" || !savedHandoff) {
    ctx.ui.notify(
      `Implementation chain reached idle before checkpoint #${checkpointTicket.id} was fully closed and handed off. No review started.`,
      "warning",
    );
    return;
  }

  const reviewConfig = getCheckpointReviewConfig();
  if (!reviewConfig.enabled || reviewConfig.skills.length === 0) {
    ctx.ui.notify(`Checkpoint #${completedCheckpoint.id} complete. Review is disabled; chain stops here.`, "info");
    return;
  }

  await startFreshCheckpointReviewSession(
    pi,
    `${completedCheckpoint.id} --feature=${completedCheckpoint.feature_key}`,
    ctx,
  );
}
