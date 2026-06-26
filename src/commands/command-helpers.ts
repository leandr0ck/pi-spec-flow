/**
 * Shared helpers for spec-flow commands — arg parsing, feature resolution,
 * session wait utilities, and model resolution.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { relative, isAbsolute } from "node:path";
import { updateTicket, type Ticket } from "../tickets-fs.js";

// ── Types ───────────────────────────────────────────────────

export type SpecFlowInitArgs = {
  specArg: string;
  featureName: string | null;
};

export type SpecFlowNextArgs = {
  ticketId: number | null;
  openInNewSession: boolean;
  feature: string | null;
};

export type CheckpointReviewCommandArgs = {
  ticketId: number | null;
  feature: string | null;
};

// ── Feature name helpers ────────────────────────────────────

export function normalizeFeatureName(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled-feature"
  );
}

export function suggestFeatureNameFromSpec(content: string, specFile: string): string {
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

// ── Arg parsing ─────────────────────────────────────────────

export function parseSpecFlowInitArgs(rawArgs?: string): SpecFlowInitArgs | null {
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

export function parseSpecFlowNextArgs(rawArgs?: string): SpecFlowNextArgs {
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

export function parseCheckpointReviewCommandArgs(rawArgs?: string): CheckpointReviewCommandArgs {
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

// ── Spec path helpers ───────────────────────────────────────

export function toStoredSpecPath(cwd: string, specPath: string): string {
  const rel = relative(cwd, specPath);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
    return rel;
  }
  return specPath;
}

// ── Feature resolution ──────────────────────────────────────

function specAlias(specFile: string): string {
  return specFile.toLowerCase().replace(/\.md$/i, "");
}

export function resolveFeatureSpec(
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

// ── Ticket helpers ──────────────────────────────────────────

export function markTicketInProgress(ticket: Ticket): Ticket {
  if (ticket.status !== "pending") return ticket;
  return updateTicket(ticket.id, { status: "in_progress" }) ?? ticket;
}

// ── Model resolution ────────────────────────────────────────

export function resolveReviewModel(ctx: ExtensionCommandContext, configuredModel: string | undefined): any | undefined {
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

// ── Session wait utilities ──────────────────────────────────

export async function waitForTurnStart(
  ctx: { isIdle: () => boolean },
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  while (ctx.isIdle()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for the injected agent turn to start.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function waitForQueuedTurnsToDrain(ctx: ExtensionCommandContext): Promise<void> {
  while (ctx.hasPendingMessages()) {
    if (ctx.isIdle()) await waitForTurnStart(ctx);
    await ctx.waitForIdle();
  }
}

export async function sendUserMessageAndWait(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  content: string,
): Promise<void> {
  const replacedSendUserMessage = (ctx as unknown as { sendUserMessage?: (content: string) => Promise<void> })
    .sendUserMessage;

  if (typeof replacedSendUserMessage === "function") {
    // ReplacedSessionContext.sendUserMessage is bound to the replacement
    // session and already resolves after the agent has finished. Waiting for
    // a later turn start after this would deadlock the command handler.
    await replacedSendUserMessage.call(ctx, content);
    return;
  }

  // ExtensionAPI.sendUserMessage is fire-and-forget in the current session, so
  // command-owned chains must explicitly wait for the injected turn and any
  // follow-up turns queued by agent_end handlers.
  pi.sendUserMessage(content);
  await waitForTurnStart(ctx);
  await ctx.waitForIdle();
  await waitForQueuedTurnsToDrain(ctx);
}
