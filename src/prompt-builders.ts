import type { Ticket } from "./tickets-fs.js";
import { formatTicketFull } from "./formatters.js";
import { getBlockForTicket } from "./checkpoints.js";

export const IMPLEMENTATION_PROTOCOL_SKILL = "spec-flow-implementation-protocol";

export function implementationProtocolLine(): string {
  return [
    `Follow the embedded ${IMPLEMENTATION_PROTOCOL_SKILL} protocol below. Do not search the filesystem for this skill file.`,
    "",
    "Protocol:",
    "1. Implement only the current ticket scope and explicit dependencies.",
    "2. Verify using the ticket's verification steps.",
    "3. Fill handoff fields with spec_flow_update:",
    "   - handoff_summary: 3–5 bullets on what changed",
    "   - handoff_files: files actually changed",
    "   - handoff_decisions: key decisions and rationale",
    "   - handoff_verification: commands/tests/manual checks and result",
    "   - handoff_risks: pending risks/TODOs or None",
    "   - handoff_next_ticket: recommended next ticket or None",
    "4. Close with spec_flow_handoff_loop_done using the current ticket ID and feature key.",
    "5. If this is a checkpoint ticket and the extension requests it, call spec_flow_checkpoint_handoff_save next.",
  ].join("\n");
}

export function ticketCloseCommand(ticket: Ticket): string {
  return `spec_flow_handoff_loop_done(ticket_id: ${ticket.id}, feature_key: "${ticket.feature_key}")`;
}

export function compactTicketInstruction(ticket: Ticket): string {
  return [
    `Current ticket: #${ticket.id}. Close with: ${ticketCloseCommand(ticket)}.`,
  ].join("\n");
}

// ── Kickoff message builders ────────────────────────────────

export function buildTicketKickoffMessage(ticket: Ticket): string {
  return [
    implementationProtocolLine(),
    "",
    `## Current ticket #${ticket.id}`,
    formatTicketFull(ticket),
    "",
    compactTicketInstruction(ticket),
  ].join("\n");
}

export function buildBlockKickoffMessage(
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
