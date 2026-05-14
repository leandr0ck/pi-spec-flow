/**
 * spec-flow commands — /spec-flow-init, /spec-flow-list, /spec-flow-next
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, basename } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import {
  initTicketsStore,
  ticketsExist,
  ticketCount,
  clearTickets,
  listTickets,
  type Ticket,
} from "./tickets-fs.js";
import { formatTicketCompact, formatTicketFull } from "./formatters.js";
import { parseSpecSections, buildSpecSummary } from "./spec-parser.js";
import { loadMethodology } from "./methodology-loader.js";

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
      if (!args) {
        ctx.ui.notify("Usage: /spec-flow-init <path-to-spec.md>", "error");
        return;
      }

      const specPath = resolve(ctx.cwd, args);
      let content: string;
      try {
        content = readFileSync(specPath, "utf-8");
      } catch {
        ctx.ui.notify(`Cannot read file: ${specPath}`, "error");
        return;
      }

      const specFile = basename(specPath);
      const { sections } = parseSpecSections(content);

      if (sections.length === 0) {
        ctx.ui.notify(
          "No '##' sections found in spec. Nothing to ticket-ify.",
          "warning"
        );
        return;
      }

      // Init tickets store
      initTicketsStore(ctx.cwd);

      // Clear existing tickets if user confirms
      const existingCount = ticketCount();
      if (existingCount > 0) {
        const replace = await ctx.ui.confirm(
          "Tickets exist",
          `${existingCount} ticket(s) already exist. Replace them?`
        );
        if (!replace) {
          ctx.ui.notify(
            "Init cancelled — existing tickets preserved.",
            "info"
          );
          return;
        }
        clearTickets();
      }

      // Send the spec + planning methodology to the LLM
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
        `2. Validate it: \`spec_flow_ticket_loop_done(ticket_id: <id>, spec_file: "${specFile}")\``,
        "3. If it passes → create the next ticket, validate it. Repeat for all tickets.",
        "4. If it fails → the fix loop starts with a validation checklist. **Re-read the spec file** to recall context, then: `spec_flow_delete` the old ticket, `spec_flow_create` corrected, `spec_flow_ticket_loop_done` again with the new ID.",
        "5. After ALL tickets pass individually, run \`spec_flow_validate_tickets\` for cross-cutting checks.",
        "",
        "Create Foundation phase tickets first, then Core Features, then Polish. Add checkpoint tickets between phases.",
        `Use spec_file: "${specFile}" for all tickets.`,
        "",
        "Every ticket MUST have: acceptance_criteria, verification, estimated_scope (XS/S/M/L), and phase.",
      ].join("\n");

      pi.sendUserMessage(msg);
      ctx.ui.notify(
        `Loaded spec "${specFile}" (${sections.length} sections). LLM will now create structured tickets.`,
        "success"
      );
    },
  });

  // ── /spec-flow-list ───────────────────────────────────────

  pi.registerCommand("spec-flow-list", {
    description: "List all spec tickets with phases and scope",
    handler: async (_args, ctx) => {
      initTicketsStore(ctx.cwd);
      if (!ticketsExist()) {
        ctx.ui.notify(
          "No tickets store. Run /spec-flow-init first.",
          "warning"
        );
        return;
      }

      const tickets = listTickets();
      if (tickets.length === 0) {
        ctx.ui.notify("No tickets found.", "info");
        return;
      }

      // Group by phase
      const phases = new Map<string, Ticket[]>();
      const unphased: Ticket[] = [];
      for (const t of tickets) {
        if (t.phase) {
          const group = phases.get(t.phase) || [];
          group.push(t);
          phases.set(t.phase, group);
        } else {
          unphased.push(t);
        }
      }

      const lines: string[] = [];
      const phaseOrder = ["Foundation", "Core Features", "Polish"];

      for (const phase of phaseOrder) {
        const group = phases.get(phase);
        if (group && group.length > 0) {
          lines.push(`**${phase}:**`);
          lines.push(...group.map(formatTicketCompact));
          lines.push("");
          phases.delete(phase);
        }
      }

      // Any remaining phases
      for (const [phase, group] of phases) {
        lines.push(`**${phase}:**`);
        lines.push(...group.map(formatTicketCompact));
        lines.push("");
      }

      if (unphased.length > 0) {
        lines.push("**Unphased:**");
        lines.push(...unphased.map(formatTicketCompact));
        lines.push("");
      }

      const statusSummary = [
        tickets.filter((t) => t.status === "done").length,
        tickets.filter((t) => t.status === "in_progress").length,
        tickets.filter((t) => t.status === "pending").length,
      ];

      lines.unshift(
        `**${tickets.length} ticket(s)** — ${statusSummary[0]} done, ${statusSummary[1]} in progress, ${statusSummary[2]} pending:`
      );

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── /spec-flow-next ───────────────────────────────────────

  pi.registerCommand("spec-flow-next", {
    description: "Show the next pending ticket with full task context",
    handler: async (_args, ctx) => {
      initTicketsStore(ctx.cwd);
      if (!ticketsExist()) {
        ctx.ui.notify(
          "No tickets store. Run /spec-flow-init first.",
          "warning"
        );
        return;
      }

      const pending = listTickets("pending");
      if (pending.length === 0) {
        const inProgress = listTickets("in_progress");
        if (inProgress.length > 0) {
          ctx.ui.notify(
            `${inProgress.length} ticket(s) in progress, none pending.`,
            "info"
          );
        } else {
          ctx.ui.notify("All tickets done!", "success");
        }
        return;
      }

      const ticket = pending[0];
      pi.sendUserMessage(formatTicketFull(ticket));
      ctx.ui.notify(
        `Sent ticket #${ticket.id}: ${ticket.title}`,
        "success"
      );
    },
  });
}
