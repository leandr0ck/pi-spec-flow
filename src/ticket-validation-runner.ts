import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getTicket, type Ticket } from "./tickets-fs.js";

const STATE_KEY = "spec-flow-ticket-validation";
const STATUS_KEY = "spec-flow-ticket-validation";
const DEFAULT_MAX_ITERATIONS = 3;

type Phase = "armed" | "awaitingFix" | "done" | "stopped";

type CheckResult = {
  field: string;
  ok: boolean;
  value: string;
  help: string;
};

export type TicketValidationState = {
  runId: string;
  phase: Phase;
  ticketId: number;
  featureKey: string;
  iteration: number;
  maxIterations: number;
  missingFields: string[];
  startedAt: number;
  updatedAt: number;
};

export function armTicketValidation(
  pi: ExtensionAPI,
  ticket: Ticket,
  maxIterations = DEFAULT_MAX_ITERATIONS,
): TicketValidationState {
  const state: TicketValidationState = {
    runId: `${Date.now()}-${ticket.id}`,
    phase: "armed",
    ticketId: ticket.id,
    featureKey: ticket.feature_key,
    iteration: 0,
    maxIterations,
    missingFields: [],
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  pi.appendEntry(STATE_KEY, state);
  return state;
}

function loadState(ctx: {
  sessionManager: { getBranch: () => Array<{ type: string; customType?: string; data?: unknown }> };
}): TicketValidationState | undefined {
  let latest: TicketValidationState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === STATE_KEY) {
      latest = entry.data as TicketValidationState;
    }
  }
  return latest;
}

function persist(pi: ExtensionAPI, state: TicketValidationState): void {
  state.updatedAt = Date.now();
  pi.appendEntry(STATE_KEY, state);
}

function buildChecks(ticket: Ticket): CheckResult[] {
  return [
    {
      field: "source_spec_path",
      ok: !!(ticket.source_spec_path && ticket.source_spec_path.trim().length > 0),
      value: ticket.source_spec_path?.trim().slice(0, 80) || "—",
      help: "Path to the real source spec document, e.g. 'docs/implementation-spec.md'",
    },
    {
      field: "acceptance_criteria",
      ok: !!(ticket.acceptance_criteria && ticket.acceptance_criteria.trim().length > 0),
      value: ticket.acceptance_criteria?.trim().slice(0, 80) || "—",
      help: "Testable conditions as bullet points, e.g. '- [ ] User can register with email/password'",
    },
    {
      field: "verification",
      ok: !!(ticket.verification && ticket.verification.trim().length > 0),
      value: ticket.verification?.trim().slice(0, 80) || "—",
      help: "How to verify, e.g. '- [ ] Tests pass: npm test'",
    },
    {
      field: "estimated_scope",
      ok: !!(ticket.estimated_scope && ["XS", "S", "M", "L"].includes(ticket.estimated_scope)),
      value: ticket.estimated_scope || "—",
      help: "Must be XS (1 file), S (1-2), M (3-5), or L (5-8)",
    },
    {
      field: "phase",
      ok: !!ticket.phase,
      value: ticket.phase || "—",
      help: "Foundation, Core Features, or Polish",
    },
  ];
}

function buildChecklist(ticket: Ticket, checks: CheckResult[]): string {
  const lines = [
    `## Validation for #${ticket.id} "${ticket.title}"`,
    "",
    "| Check | Status | Current |",
    "|-------|--------|--------|",
  ];
  for (const c of checks) {
    const icon = c.ok ? "✅" : "❌";
    const val = c.ok ? c.value : `**MISSING** — ${c.help}`;
    lines.push(`| ${c.field} | ${icon} | ${val} |`);
  }
  return lines.join("\n");
}

function buildFixPrompt(ticket: Ticket, state: TicketValidationState, missingFields: string[]): string {
  return [
    `🔁 **TICKET FIX LOOP** — #${ticket.id} "${ticket.title}" (${state.iteration}/${state.maxIterations})`,
    "Re-read the source spec if needed.",
    `Missing fields: ${missingFields.join(", ")}.`,
    "Update only those fields using `spec_flow_update`. Do not create the next ticket until this one passes validation.",
  ].join("\n");
}

function buildPassPrompt(ticket: Ticket): string {
  return [
    `✅ Ticket #${ticket.id} passes validation.`,
    "Create the next ticket with `spec_flow_create`, or if all tickets for the spec are created, run `spec_flow_validate_tickets` for cross-cutting checks.",
  ].join("\n");
}

export async function runTicketValidationEvent(pi: ExtensionAPI, ctx: any): Promise<void> {
  const state = loadState(ctx);
  if (!state || state.phase === "done" || state.phase === "stopped") return;

  const ticket = getTicket(state.ticketId);
  if (!ticket) {
    state.phase = "stopped";
    persist(pi, state);
    ctx.ui.notify(`Ticket #${state.ticketId} not found. Ticket validation stopped.`, "warning");
    return;
  }

  const checks = buildChecks(ticket);
  const missingFields = checks.filter((check) => !check.ok).map((check) => check.field);
  const passed = missingFields.length === 0;

  if (passed) {
    state.phase = "done";
    state.missingFields = [];
    persist(pi, state);
    ctx.ui.setStatus(STATUS_KEY, "");
    ctx.ui.notify(`Ticket #${ticket.id} passes validation.`, "success");
    pi.sendUserMessage(buildPassPrompt(ticket), { deliverAs: "followUp" });
    return;
  }

  state.iteration += 1;
  state.missingFields = missingFields;

  if (state.iteration > state.maxIterations) {
    state.phase = "stopped";
    persist(pi, state);
    ctx.ui.setStatus(STATUS_KEY, "");
    pi.sendUserMessage(
      [
        `⚠️ **TICKET VALIDATION STOPPED** — Max iterations (${state.maxIterations}) on #${ticket.id} "${ticket.title}"`,
        `Still missing: ${missingFields.join(", ")}. Review manually.`,
        "",
        buildChecklist(ticket, checks),
      ].join("\n"),
      { deliverAs: "followUp" },
    );
    return;
  }

  state.phase = "awaitingFix";
  persist(pi, state);
  ctx.ui.setStatus(STATUS_KEY, `Validating ticket #${ticket.id}: ${state.iteration}/${state.maxIterations}`);
  pi.sendUserMessage(
    [buildFixPrompt(ticket, state, missingFields), "", buildChecklist(ticket, checks)].join("\n"),
    { deliverAs: "followUp" },
  );
}
