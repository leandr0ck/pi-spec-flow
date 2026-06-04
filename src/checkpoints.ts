import type { Ticket } from "./tickets-fs.js";

export type TicketBlock = {
  tickets: Ticket[];
  firstTicket: Ticket;
  lastTicket: Ticket;
  checkpointTicket: Ticket | null;
};

function findTicketIndex(tickets: Ticket[], ticketId: number): number {
  return tickets.findIndex((ticket) => ticket.id === ticketId);
}

export function getBlockForTicket(
  orderedTickets: Ticket[],
  ticketId: number,
): TicketBlock | null {
  const currentIndex = findTicketIndex(orderedTickets, ticketId);
  if (currentIndex === -1) return null;

  let startIndex = currentIndex;
  while (startIndex > 0 && !orderedTickets[startIndex - 1]?.is_checkpoint) {
    startIndex -= 1;
  }

  let endIndex = currentIndex;
  while (endIndex < orderedTickets.length - 1 && !orderedTickets[endIndex]?.is_checkpoint) {
    endIndex += 1;
  }

  const tickets = orderedTickets.slice(startIndex, endIndex + 1);
  const checkpointTicket = tickets.find((ticket) => ticket.is_checkpoint) ?? null;
  const firstTicket = tickets[0];
  const lastTicket = tickets[tickets.length - 1];

  if (!firstTicket || !lastTicket) return null;

  return {
    tickets,
    firstTicket,
    lastTicket,
    checkpointTicket,
  };
}

export function getNextTicketInBlock(
  orderedTickets: Ticket[],
  ticketId: number,
): Ticket | undefined {
  const block = getBlockForTicket(orderedTickets, ticketId);
  if (!block) return undefined;

  const currentIndexInBlock = block.tickets.findIndex((ticket) => ticket.id === ticketId);
  if (currentIndexInBlock === -1) return undefined;

  return block.tickets[currentIndexInBlock + 1];
}

export function getNextTicketAfterBlock(
  orderedTickets: Ticket[],
  ticketId: number,
): Ticket | undefined {
  const block = getBlockForTicket(orderedTickets, ticketId);
  if (!block) return undefined;

  const lastIndex = findTicketIndex(orderedTickets, block.lastTicket.id);
  if (lastIndex === -1) return undefined;

  return orderedTickets[lastIndex + 1];
}

export function isFirstTicketOfBlock(
  orderedTickets: Ticket[],
  ticketId: number,
): boolean {
  const block = getBlockForTicket(orderedTickets, ticketId);
  return block?.firstTicket.id === ticketId;
}

export function getPreviousCheckpointTicket(
  orderedTickets: Ticket[],
  ticketId: number,
): Ticket | undefined {
  const currentIndex = findTicketIndex(orderedTickets, ticketId);
  if (currentIndex <= 0) return undefined;

  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    if (orderedTickets[index]?.is_checkpoint) {
      return orderedTickets[index];
    }
  }

  return undefined;
}
