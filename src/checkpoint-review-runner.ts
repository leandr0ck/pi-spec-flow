import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import {
  getCheckpointReviewConfig,
  getTicket,
  listTicketsForSpec,
  type Ticket,
  type ThinkingLevel,
} from "./tickets-fs.js";
import { loadCheckpointHandoff } from "./checkpoint-handoffs.js";
import { getNextTicketAfterBlock } from "./checkpoints.js";
import { resolveConfiguredModel, type ModelLike } from "./commands.js";

export const CHECKPOINT_REVIEW_STATE_KEY = "spec-flow-checkpoint-review";
const STATUS_KEY = "spec-flow-review";
const REVIEW_PROMPT_MARKER = "<!-- spec-flow-checkpoint-review -->";

type StoredModel = {
  provider: string;
  id: string;
  name?: string;
};

export type CheckpointReviewState = {
  runId: string;
  phase: "armed" | "reviewRunning" | "done" | "error";
  ticketId: number;
  featureKey: string;
  skills: string[];
  filesChanged: string[];
  handoffContent?: string;
  nextTicketId?: number;
  reviewModel?: string;
  reviewThinking?: ThinkingLevel;
  originalModel?: StoredModel;
  originalThinking?: ThinkingLevel;
  activeReviewModel?: StoredModel;
  startedAt?: number;
  endedAt?: number;
  reviewPromptMarker?: string;
  lastError?: string;
};

function toStoredModel(model: unknown): StoredModel | undefined {
  const candidate = model as Partial<StoredModel> | undefined;
  if (!candidate?.provider || !candidate.id) return undefined;
  return {
    provider: candidate.provider,
    id: candidate.id,
    name: candidate.name,
  };
}

function findStoredModel(
  modelRegistry: { find: (provider: string, modelId: string) => ModelLike | undefined },
  stored: StoredModel | undefined,
): ModelLike | undefined {
  if (!stored) return undefined;
  return modelRegistry.find(stored.provider, stored.id);
}

function extractFilesFromCheckpointHandoff(cwd: string, ticket: Ticket): string[] {
  const handoff = loadCheckpointHandoff(cwd, ticket.feature_key, ticket.id);
  if (!handoff) return [];
  const match = handoff.content.match(/### Files changed\n([\s\S]*?)(?=\n### |$)/i);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length > 0 && !/^none recorded$/i.test(line));
}

function loadCheckpointHandoffContent(cwd: string, ticket: Ticket): string | undefined {
  return loadCheckpointHandoff(cwd, ticket.feature_key, ticket.id)?.content;
}

function findSkillPath(skill: string, cwd: string): string | undefined {
  if (isAbsolute(skill)) return existsSync(skill) ? skill : undefined;

  const directCandidates = [
    join(cwd, ".pi", "skills", skill, "SKILL.md"),
    join(cwd, ".agents", "skills", skill, "SKILL.md"),
    join(homedir(), ".pi", "agent", "skills", skill, "SKILL.md"),
    join(homedir(), ".agents", "skills", skill, "SKILL.md"),
  ];
  for (const candidate of directCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  const roots = [
    join(cwd, ".pi", "skills"),
    join(cwd, ".agents", "skills"),
    join(homedir(), ".pi", "agent", "skills"),
    join(homedir(), ".agents", "skills"),
  ];

  const visit = (dir: string, depth: number): string | undefined => {
    if (depth < 0 || !existsSync(dir)) return undefined;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return undefined;
    }
    if (entries.includes(skill)) {
      const candidate = join(dir, skill, "SKILL.md");
      if (existsSync(candidate)) return candidate;
    }
    for (const entry of entries) {
      const found = visit(join(dir, entry), depth - 1);
      if (found) return found;
    }
    return undefined;
  };

  for (const root of roots) {
    const found = visit(root, 4);
    if (found) return found;
  }

  return undefined;
}

function loadSkillInstructions(skills: string[], cwd: string): string {
  const sections: string[] = [];
  for (const skill of skills) {
    const skillPath = findSkillPath(skill, cwd);
    if (!skillPath) {
      sections.push(`## Skill: ${skill}\n\nSkill file not found. Use the skill name as high-level guidance only.`);
      continue;
    }
    const content = readFileSync(skillPath, "utf8").trim();
    sections.push(`## Skill: ${skill}\nPath: ${skillPath}\n\n${content}`);
  }
  return sections.join("\n\n---\n\n");
}

export function loadCheckpointReviewState(ctx: {
  sessionManager: { getBranch: () => Array<{ type: string; customType?: string; data?: unknown }> };
}): CheckpointReviewState | undefined {
  let latest: CheckpointReviewState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === CHECKPOINT_REVIEW_STATE_KEY) {
      latest = entry.data as CheckpointReviewState;
    }
  }
  return latest;
}

export function hasActiveCheckpointReview(ctx: {
  sessionManager: { getBranch: () => Array<{ type: string; customType?: string; data?: unknown }> };
}): boolean {
  const state = loadCheckpointReviewState(ctx);
  return state?.phase === "armed" || state?.phase === "reviewRunning";
}

export function armCheckpointReview(
  pi: ExtensionAPI,
  ctx: { cwd: string; model?: unknown },
  ticket: Ticket,
): CheckpointReviewState {
  const reviewConfig = getCheckpointReviewConfig();
  const orderedTickets = listTicketsForSpec(ticket.feature_key);
  const nextAfterBlock = getNextTicketAfterBlock(orderedTickets, ticket.id);
  const state: CheckpointReviewState = {
    runId: `${Date.now()}-${ticket.id}`,
    phase: "armed",
    ticketId: ticket.id,
    featureKey: ticket.feature_key,
    skills: reviewConfig.skills,
    filesChanged: extractFilesFromCheckpointHandoff(ctx.cwd, ticket),
    handoffContent: loadCheckpointHandoffContent(ctx.cwd, ticket),
    nextTicketId: nextAfterBlock?.id,
    reviewModel: reviewConfig.model,
    reviewThinking: reviewConfig.thinkingLevel,
    originalModel: toStoredModel(ctx.model),
    originalThinking: pi.getThinkingLevel() as ThinkingLevel,
  };
  pi.appendEntry(CHECKPOINT_REVIEW_STATE_KEY, state);
  return state;
}

function buildReviewPrompt(state: CheckpointReviewState, skillInstructions: string): string {
  const skillsList = state.skills.map((skill) => `$${skill}`).join(", ");
  const filesHint = state.filesChanged.length > 0
    ? `\n\nFocus on these changed files: ${state.filesChanged.join(", ")}.`
    : "";
  const nextHint = state.nextTicketId
    ? `\n\nAfter the review, report findings and wait. The extension will restore the original model automatically. If there are no blocking issues, the user can continue with /spec-flow-next --new ${state.nextTicketId} --feature=${state.featureKey}.`
    : "\n\nAfter the review, report final findings. The extension will restore the original model automatically.";

  return [
    REVIEW_PROMPT_MARKER,
    "",
    `**Checkpoint Code Review** — Block ending at #${state.ticketId}`,
    "",
    "You are now in checkpoint code-review mode.",
    "Do not summarize the checkpoint handoff. Perform the review now.",
    `Use these configured review skills/procedures: ${skillsList}.`,
    "",
    "## Loaded skill instructions",
    "",
    skillInstructions || "No skill instructions were found; perform a strict code review anyway.",
    "",
    "## Checkpoint handoff to review",
    "",
    state.handoffContent ?? "No checkpoint handoff content found.",
    filesHint,
    nextHint,
  ].join("");
}

function messageText(message: any): string {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part?.type === "text" ? part.text ?? "" : "")
    .join("\n");
}

function isReviewPromptTurn(event: { messages?: any[] }, marker: string | undefined): boolean {
  const needle = marker || REVIEW_PROMPT_MARKER;
  return (event.messages ?? []).some((message) =>
    message?.role === "user" && messageText(message).includes(needle),
  );
}

function persist(pi: ExtensionAPI, state: CheckpointReviewState) {
  pi.appendEntry(CHECKPOINT_REVIEW_STATE_KEY, state);
}

export async function runCheckpointReviewEvent(
  pi: ExtensionAPI,
  ctx: any,
  event?: { messages?: any[] },
  stateOverride?: CheckpointReviewState,
): Promise<CheckpointReviewState | undefined> {
  const state = stateOverride ?? loadCheckpointReviewState(ctx);
  if (!state || state.phase === "done") return state;

  if (state.phase === "armed") {
    if (ctx.hasPendingMessages?.()) {
      ctx.ui.setStatus(STATUS_KEY, `Checkpoint review armed for #${state.ticketId}; waiting for queued messages`);
      return state;
    }

    const ticket = getTicket(state.ticketId);
    if (!ticket) return state;

    try {
      let activeReviewModel: StoredModel | undefined;
      if (state.reviewModel) {
        const resolution = resolveConfiguredModel(ctx.modelRegistry, state.reviewModel);
        if (resolution.model) {
          const success = await pi.setModel(resolution.model as never);
          if (!success) {
            ctx.ui.notify(
              `No API key for review model ${resolution.model.provider}/${resolution.model.id}; using current model.`,
              "warning",
            );
          } else {
            activeReviewModel = toStoredModel(resolution.model);
            ctx.ui.notify(`Review model selected: ${resolution.model.provider}/${resolution.model.id}`, "info");
          }
        } else if (resolution.warning) {
          ctx.ui.notify(`${resolution.warning}; using current model.`, "warning");
        }
      }

      if (state.reviewThinking) {
        pi.setThinkingLevel(state.reviewThinking);
      }

      state.phase = "reviewRunning";
      state.startedAt = Date.now();
      state.activeReviewModel = activeReviewModel;
      state.reviewPromptMarker = REVIEW_PROMPT_MARKER;
      persist(pi, state);
      ctx.ui.setStatus(STATUS_KEY, `Reviewing checkpoint #${state.ticketId}`);
      pi.sendUserMessage(buildReviewPrompt(state, loadSkillInstructions(state.skills, ctx.cwd)));
    } catch (error: any) {
      state.phase = "error";
      state.lastError = error?.message ?? String(error);
      persist(pi, state);
      ctx.ui.notify(state.lastError, "error");
    }
    return state;
  }

  if (state.phase === "reviewRunning") {
    if (!event || !isReviewPromptTurn(event, state.reviewPromptMarker)) {
      ctx.ui.setStatus(STATUS_KEY, `Checkpoint review queued/running for #${state.ticketId}`);
      return state;
    }

    const original = findStoredModel(ctx.modelRegistry, state.originalModel);
    if (original) {
      await pi.setModel(original as never);
    }
    if (state.originalThinking) {
      pi.setThinkingLevel(state.originalThinking);
    }
    state.phase = "done";
    state.endedAt = Date.now();
    persist(pi, state);
    ctx.ui.setStatus(STATUS_KEY, "");
    ctx.ui.notify("Checkpoint review complete. Original model and thinking level restored.", "info");
  }
  return state;
}
