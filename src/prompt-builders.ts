import type { Ticket } from "./tickets-fs.js";
import { formatTicketFull } from "./formatters.js";
import { getBlockForTicket } from "./checkpoints.js";

export const IMPLEMENTATION_PROTOCOL_SKILL = "spec-flow-implementation-protocol";

export function implementationProtocolLine(): string {
  return `Follow the ${IMPLEMENTATION_PROTOCOL_SKILL} skill.`;
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
