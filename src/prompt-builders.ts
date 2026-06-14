import type { Ticket } from "./tickets-fs.js";

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
