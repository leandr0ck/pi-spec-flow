/**
 * spec-flow tools — planning + implementation closeout loops
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  initTicketsStore,
  ticketsExist,
  insertFullTicket,
  listTickets,
  listTicketsForSpec,
  getTicket,
  updateTicket,
  type Ticket,
  type CreateTicketInput,
  type UpdateTicketInput,
} from "./tickets-fs.js";
import { formatTicketCompact } from "./formatters.js";
import {
  loadLoopState,
  saveLoopState,
  createLoopState,
} from "./ticket-loop.js";

type HandoffCheckResult = {
  field: string;
  ok: boolean;
  value: string;
  help: string;
};

function asTrimmedText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function buildHandoffChecks(ticket: Ticket): HandoffCheckResult[] {
  return [
    {
      field: "handoff_summary",
      ok: asTrimmedText(ticket.handoff_summary).length > 0,
      value: asTrimmedText(ticket.handoff_summary).slice(0, 80) || "—",
      help: "3-5 bullets: what was implemented",
    },
    {
      field: "handoff_files",
      ok: asTrimmedText(ticket.handoff_files).length > 0,
      value: asTrimmedText(ticket.handoff_files).slice(0, 80) || "—",
      help: "Files actually touched during implementation",
    },
    {
      field: "handoff_decisions",
      ok: asTrimmedText(ticket.handoff_decisions).length > 0,
      value: asTrimmedText(ticket.handoff_decisions).slice(0, 80) || "—",
      help: "Key decisions and rationale",
    },
    {
      field: "handoff_verification",
      ok: asTrimmedText(ticket.handoff_verification).length > 0,
      value: asTrimmedText(ticket.handoff_verification).slice(0, 80) || "—",
      help: "Tests/commands run + concrete result",
    },
    {
      field: "handoff_risks",
      ok: asTrimmedText(ticket.handoff_risks).length > 0,
      value: asTrimmedText(ticket.handoff_risks).slice(0, 80) || "—",
      help: "Pending risks, TODOs, or explicit 'None'",
    },
    {
      field: "handoff_next_ticket",
      ok: asTrimmedText(ticket.handoff_next_ticket).length > 0,
      value: asTrimmedText(ticket.handoff_next_ticket).slice(0, 80) || "—",
      help: "Recommended next ticket ID / follow-up",
    },
  ];
}

function buildHandoffChecklist(ticket: Ticket, checks: HandoffCheckResult[]): string {
  const lines = [
    `## Handoff validation for #${ticket.id} "${ticket.title}"`,
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

function queueNextTicketSession(
  pi: ExtensionAPI,
  ticket: Ticket,
): string {
  const inProgress = listTicketsForSpec(ticket.spec_file, "in_progress").filter(
    (t) => t.id !== ticket.id
  );
  const pending = listTicketsForSpec(ticket.spec_file, "pending");
  const next = inProgress[0] || pending[0];

  if (next) {
    pi.sendUserMessage(`/spec-flow-next --new ${next.id}`, {
      deliverAs: "followUp",
    });
    return `\nAuto-chain enabled: queuing /spec-flow-next --new ${next.id} to continue.`;
  }

  return "\nAuto-chain: no remaining pending/in-progress tickets in this feature.";
}

// ── Tool registration ───────────────────────────────────────

export function registerTools(pi: ExtensionAPI): void {
  // ── spec_flow_create ──────────────────────────────────────

  pi.registerTool({
    name: "spec_flow_create",
    label: "Spec Flow Create",
    description:
      "Create a new spec ticket with full planning-and-task-breakdown fields. Use after analyzing the spec to create properly structured tasks.",
    promptSnippet:
      "spec_flow_create(title, description, source_section, spec_file, acceptance_criteria?, verification?, dependencies?, files_touched?, estimated_scope?, phase?, is_checkpoint?, risks?, open_questions?, order_index?)",
    promptGuidelines: [
      "Use spec_flow_create to create tickets after /spec-flow-init loads a spec.",
      "Every ticket must have acceptance_criteria and verification steps.",
      "estimated_scope must be one of: XS, S, M, L. XL tasks must be broken down further.",
      "Set is_checkpoint: true for checkpoint tickets between phases (every 2-3 tasks).",
      "Use phase to group tasks: 'Foundation', 'Core Features', 'Polish'.",
      "dependencies should reference other ticket IDs or be 'None'.",
    ],
    parameters: Type.Object({
      title: Type.String({
        description: "Short descriptive task title",
      }),
      description: Type.String({
        description:
          "One paragraph explaining what this task accomplishes",
      }),
      source_section: Type.String({
        description:
          "The spec section reference, e.g. '## User Authentication'",
      }),
      spec_file: Type.String({
        description: "The spec file name, e.g. 'spec.md'",
      }),

      acceptance_criteria: Type.Optional(
        Type.String({
          description:
            "Specific, testable conditions as bullet points. e.g. '- [ ] User can register with email/password\n- [ ] Invalid email shows error'",
        })
      ),
      verification: Type.Optional(
        Type.String({
          description:
            "Verification steps. e.g. '- [ ] Tests pass: npm test -- --grep \"auth\"\n- [ ] Build succeeds: npm run build\n- [ ] Manual: register a new user'",
        })
      ),
      dependencies: Type.Optional(
        Type.String({
          description:
            "Comma-separated task IDs this depends on, or 'None'",
        })
      ),
      files_touched: Type.Optional(
        Type.String({
          description:
            "Likely files for this task, e.g. 'src/routes/auth.ts, tests/auth.test.ts'",
        })
      ),
      estimated_scope: Type.Optional(
        StringEnum(["XS", "S", "M", "L"] as const, {
          description:
            "XS=1 file, S=1-2 files, M=3-5 files, L=5-8 files. XL tasks must be broken down.",
        })
      ),
      phase: Type.Optional(
        Type.String({
          description:
            "Phase grouping: 'Foundation', 'Core Features', or 'Polish'",
        })
      ),
      is_checkpoint: Type.Optional(
        Type.Boolean({
          description:
            "Set true for checkpoint tickets that verify preceding tasks (every 2-3 tasks)",
        })
      ),
      risks: Type.Optional(
        Type.String({
          description:
            "Known risks for this task, e.g. 'Might conflict with existing auth middleware'",
        })
      ),
      open_questions: Type.Optional(
        Type.String({
          description:
            "Questions needing human input before implementation",
        })
      ),
      order_index: Type.Optional(
        Type.Number({
          description:
            "Explicit ordering within a phase (lower = earlier)",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      initTicketsStore(ctx.cwd);
      if (!ticketsExist()) {
        return {
          content: [
            {
              type: "text",
              text: "No tickets store found. Ask the user to run /spec-flow-init first.",
            },
          ],
          details: {},
        };
      }

      const input: CreateTicketInput = {
        title: params.title,
        description: params.description,
        source_section: params.source_section,
        spec_file: params.spec_file,
        acceptance_criteria: params.acceptance_criteria,
        verification: params.verification,
        dependencies: params.dependencies,
        files_touched: params.files_touched,
        estimated_scope: params.estimated_scope,
        phase: params.phase,
        is_checkpoint: params.is_checkpoint,
        risks: params.risks,
        open_questions: params.open_questions,
        order_index: params.order_index,
      };

      const ticket = insertFullTicket(input);
      const summary = formatTicketCompact(ticket);
      return {
        content: [{ type: "text", text: `Created ${summary}` }],
        details: { ticket },
      };
    },
  });

  // ── spec_flow_update ──────────────────────────────────────

  pi.registerTool({
    name: "spec_flow_update",
    label: "Spec Flow Update",
    description:
      "Update a spec ticket's status and/or fields. Use to mark progress, fix validation issues, or edit any ticket field without recreating it.",
    promptSnippet:
      "spec_flow_update(id: number, status?, auto_next?, title?, description?, acceptance_criteria?, verification?, ...)",
    promptGuidelines: [
      "Use spec_flow_update to mark a ticket as in_progress when starting work, or done when completed.",
      "When closing a ticket, include full handoff fields (summary/files/decisions/verification/risks/next ticket).",
      "Auto-chain is enabled by default when status='done'. Set auto_next: false to disable.",
      "Use spec_flow_update to fix validation issues without deleting and recreating the ticket.",
      "Only pass the fields that need to change — unchanged fields are preserved automatically.",
      "For example: spec_flow_update(id: 1, acceptance_criteria: '- [ ] User can log in with email/password')",
    ],
    parameters: Type.Object({
      id: Type.Number({ description: "Ticket ID to update" }),
      status: Type.Optional(
        StringEnum(["pending", "in_progress", "done"] as const, {
          description: "New status for the ticket",
        })
      ),
      auto_next: Type.Optional(
        Type.Boolean({
          description:
            "When status='done': true (default) opens next ticket in fresh session; false disables auto-chain",
        })
      ),
      title: Type.Optional(
        Type.String({ description: "New title" })
      ),
      description: Type.Optional(
        Type.String({ description: "New description" })
      ),
      source_section: Type.Optional(
        Type.String({ description: "Spec section reference, e.g. '## User Authentication'" })
      ),
      spec_file: Type.Optional(
        Type.String({ description: "The spec file name, e.g. 'spec.md'" })
      ),
      acceptance_criteria: Type.Optional(
        Type.String({
          description:
            "Specific, testable conditions as bullet points. e.g. '- [ ] User can register with email/password\n- [ ] Invalid email shows error'",
        })
      ),
      verification: Type.Optional(
        Type.String({
          description:
            "Verification steps. e.g. '- [ ] Tests pass: npm test -- --grep \"auth\"\n- [ ] Build succeeds: npm run build\n- [ ] Manual: register a new user'",
        })
      ),
      dependencies: Type.Optional(
        Type.String({
          description:
            "Comma-separated task IDs this depends on, or 'None'",
        })
      ),
      files_touched: Type.Optional(
        Type.String({
          description:
            "Likely files for this task, e.g. 'src/routes/auth.ts, tests/auth.test.ts'",
        })
      ),
      estimated_scope: Type.Optional(
        StringEnum(["XS", "S", "M", "L"] as const, {
          description:
            "XS=1 file, S=1-2 files, M=3-5 files, L=5-8 files. XL tasks must be broken down.",
        })
      ),
      phase: Type.Optional(
        Type.String({
          description:
            "Phase grouping: 'Foundation', 'Core Features', or 'Polish'",
        })
      ),
      is_checkpoint: Type.Optional(
        Type.Boolean({
          description:
            "Set true for checkpoint tickets that verify preceding tasks (every 2-3 tasks)",
        })
      ),
      risks: Type.Optional(
        Type.String({
          description:
            "Known risks for this task, e.g. 'Might conflict with existing auth middleware'",
        })
      ),
      open_questions: Type.Optional(
        Type.String({
          description:
            "Questions needing human input before implementation",
        })
      ),
      order_index: Type.Optional(
        Type.Number({
          description:
            "Explicit ordering within a phase (lower = earlier)",
        })
      ),
      handoff_summary: Type.Optional(
        Type.String({ description: "Handoff: what was implemented (3-5 bullets)" })
      ),
      handoff_files: Type.Optional(
        Type.String({ description: "Handoff: files actually changed" })
      ),
      handoff_decisions: Type.Optional(
        Type.String({ description: "Handoff: key decisions and rationale" })
      ),
      handoff_verification: Type.Optional(
        Type.String({ description: "Handoff: tests/commands run + result" })
      ),
      handoff_risks: Type.Optional(
        Type.String({ description: "Handoff: pending risks/TODOs (or 'None')" })
      ),
      handoff_next_ticket: Type.Optional(
        Type.String({ description: "Handoff: recommended next ticket" })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      initTicketsStore(ctx.cwd);
      if (!ticketsExist()) {
        return {
          content: [
            { type: "text", text: "No tickets store found." },
          ],
          details: {},
        };
      }

      // Build the fields map from what was provided
      const fields: UpdateTicketInput = {};
      if (params.status !== undefined) fields.status = params.status;
      if (params.title !== undefined) fields.title = params.title;
      if (params.description !== undefined) fields.description = params.description;
      if (params.source_section !== undefined) fields.source_section = params.source_section;
      if (params.spec_file !== undefined) fields.spec_file = params.spec_file;
      if (params.acceptance_criteria !== undefined) fields.acceptance_criteria = params.acceptance_criteria;
      if (params.verification !== undefined) fields.verification = params.verification;
      if (params.dependencies !== undefined) fields.dependencies = params.dependencies;
      if (params.files_touched !== undefined) fields.files_touched = params.files_touched;
      if (params.estimated_scope !== undefined) fields.estimated_scope = params.estimated_scope;
      if (params.phase !== undefined) fields.phase = params.phase;
      if (params.is_checkpoint !== undefined) fields.is_checkpoint = params.is_checkpoint;
      if (params.risks !== undefined) fields.risks = params.risks;
      if (params.open_questions !== undefined) fields.open_questions = params.open_questions;
      if (params.order_index !== undefined) fields.order_index = params.order_index;
      if (params.handoff_summary !== undefined) fields.handoff_summary = params.handoff_summary;
      if (params.handoff_files !== undefined) fields.handoff_files = params.handoff_files;
      if (params.handoff_decisions !== undefined) fields.handoff_decisions = params.handoff_decisions;
      if (params.handoff_verification !== undefined) fields.handoff_verification = params.handoff_verification;
      if (params.handoff_risks !== undefined) fields.handoff_risks = params.handoff_risks;
      if (params.handoff_next_ticket !== undefined) fields.handoff_next_ticket = params.handoff_next_ticket;

      const current = getTicket(params.id);
      if (!current) {
        return {
          content: [
            {
              type: "text",
              text: `Ticket #${params.id} not found.`,
            },
          ],
          details: {},
        };
      }

      if (params.status === "done") {
        const mergedHandoffTicket: Ticket = {
          ...current,
          handoff_summary:
            fields.handoff_summary !== undefined
              ? fields.handoff_summary
              : current.handoff_summary,
          handoff_files:
            fields.handoff_files !== undefined
              ? fields.handoff_files
              : current.handoff_files,
          handoff_decisions:
            fields.handoff_decisions !== undefined
              ? fields.handoff_decisions
              : current.handoff_decisions,
          handoff_verification:
            fields.handoff_verification !== undefined
              ? fields.handoff_verification
              : current.handoff_verification,
          handoff_risks:
            fields.handoff_risks !== undefined
              ? fields.handoff_risks
              : current.handoff_risks,
          handoff_next_ticket:
            fields.handoff_next_ticket !== undefined
              ? fields.handoff_next_ticket
              : current.handoff_next_ticket,
        };
        const handoffChecks = buildHandoffChecks(mergedHandoffTicket);
        const missing = handoffChecks.filter((c) => !c.ok);
        if (missing.length > 0) {
          delete fields.status;
          const updatedWithoutDone = updateTicket(params.id, fields);
          if (!updatedWithoutDone) {
            return {
              content: [
                { type: "text", text: `Ticket #${params.id} not found.` },
              ],
              details: {},
            };
          }

          const checklist = buildHandoffChecklist(updatedWithoutDone, handoffChecks);
          pi.sendUserMessage(
            [
              `🔁 **HANDOFF LOOP REQUIRED** — #${updatedWithoutDone.id} "${updatedWithoutDone.title}"`,
              "",
              checklist,
              "",
              "No se marcó como done porque faltan campos de handoff.",
              "Completá SOLO los campos ❌ con `spec_flow_update`, luego corré:",
              `\`spec_flow_handoff_loop_done(ticket_id: ${updatedWithoutDone.id}, spec_file: \"${updatedWithoutDone.spec_file}\")\``,
            ].join("\n"),
            { deliverAs: "followUp" },
          );

          return {
            content: [
              {
                type: "text",
                text: `Ticket #${updatedWithoutDone.id} not marked done. ${missing.length} handoff field(s) missing. Follow-up checklist sent.`,
              },
            ],
            details: { ticket: updatedWithoutDone, missing_handoff: missing.map((m) => m.field) },
          };
        }
      }

      const updated = updateTicket(params.id, fields);
      if (!updated) {
        return {
          content: [
            {
              type: "text",
              text: `Ticket #${params.id} not found.`,
            },
          ],
          details: {},
        };
      }

      const changed = Object.keys(fields).join(", ");
      let text = `Ticket #${updated.id} "${updated.title}" — updated: ${changed}`;

      const shouldAutoChain = params.status === "done" && params.auto_next !== false;
      if (shouldAutoChain) {
        text += queueNextTicketSession(pi, updated);
      }

      return {
        content: [{ type: "text", text }],
        details: { ticket: updated },
      };
    },
  });

  // ── spec_flow_handoff_loop_done ─────────────────────────
  //  Per-ticket handoff loop: validates closeout fields before allowing done.

  pi.registerTool({
    name: "spec_flow_handoff_loop_done",
    label: "Handoff Loop Done",
    description:
      "Validate ONE ticket handoff before closing. If it passes, marks done. If it fails, fix and call again until pass or max iterations.",
    promptSnippet:
      "spec_flow_handoff_loop_done(ticket_id, spec_file, max_iterations?)",
    promptGuidelines: [
      "Call when finishing implementation for a ticket.",
      "If handoff passes → ticket is marked done (and auto-chains by default).",
      "If it fails → fix only missing handoff fields via spec_flow_update, then call this again with same ticket_id.",
      "DO NOT delete/recreate tickets.",
      "Loop auto-stops when ticket passes or max_iterations (default 3) reached.",
    ],
    parameters: Type.Object({
      ticket_id: Type.Number({
        description: "The ID of the ticket to close",
      }),
      spec_file: Type.String({
        description: "The spec file name, used to scope loop state",
      }),
      max_iterations: Type.Optional(
        Type.Number({
          description: "Max fix iterations for this ticket (default: 3).",
        }),
      ),
      auto_next: Type.Optional(
        Type.Boolean({
          description: "When done: true (default) queues /spec-flow-next; false disables auto-chain",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const maxIter = params.max_iterations ?? 3;
      const loopName = `handoff:${params.spec_file}:${params.ticket_id}`;
      let state = loadLoopState(ctx.cwd);

      if (ctx.hasPendingMessages()) {
        return {
          content: [{ type: "text", text: "Pending messages already queued. Call again after processing them." }],
          details: {},
        };
      }

      if (state && state.status === "active" && state.name !== loopName) {
        return {
          content: [{
            type: "text",
            text: `Another loop is active (${state.name}). Finish it first or stop it before starting handoff loop for #${params.ticket_id}.`,
          }],
          details: {},
        };
      }

      initTicketsStore(ctx.cwd);
      const ticket = getTicket(params.ticket_id);
      if (!ticket) {
        return {
          content: [{ type: "text", text: `Ticket #${params.ticket_id} not found.` }],
          details: {},
        };
      }

      const checks = buildHandoffChecks(ticket);
      const passed = checks.every((c) => c.ok);
      const checklist = buildHandoffChecklist(ticket, checks);

      // ── No active loop → first validation of this ticket ──
      if (!state || state.status !== "active") {
        if (passed) {
          const doneTicket = updateTicket(ticket.id, { status: "done" });
          if (!doneTicket) {
            return {
              content: [{ type: "text", text: `Ticket #${ticket.id} not found.` }],
              details: {},
            };
          }

          let text = checklist + `\n\n✅ Handoff complete. Ticket #${ticket.id} marked as done.`;
          if (params.auto_next !== false) {
            text += queueNextTicketSession(pi, doneTicket);
          }

          return {
            content: [{ type: "text", text }],
            details: { ticket: doneTicket },
          };
        }

        state = createLoopState(ctx.cwd, loopName, maxIter);
        state.iteration++; // first pass done
        saveLoopState(ctx.cwd, state);

        const prompt = [
          `🔁 **HANDOFF FIX LOOP** — #${ticket.id} (1/${maxIter})`,
          "",
          checklist,
          "",
          "**To fix:**",
          `1. \`spec_flow_update(id: ${ticket.id}, <handoff_fields>)\` — set ONLY fields marked ❌`,
          `2. \`spec_flow_handoff_loop_done(ticket_id: ${ticket.id}, spec_file: \"${params.spec_file}\")\``,
        ].join("\n");
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });

        return {
          content: [{ type: "text", text: `${checks.filter((c) => !c.ok).length} handoff field(s) missing on #${ticket.id}. Fix loop started.` }],
          details: {},
        };
      }

      // ── Active loop: advance iteration ──
      state.iteration++;
      saveLoopState(ctx.cwd, state);
      const iter = state.iteration - 1;

      if (passed) {
        state.status = "completed";
        state.completedAt = new Date().toISOString();
        saveLoopState(ctx.cwd, state);

        const doneTicket = updateTicket(ticket.id, { status: "done" });
        if (!doneTicket) {
          return {
            content: [{ type: "text", text: `Ticket #${ticket.id} not found.` }],
            details: {},
          };
        }

        let text = checklist + `\n\n✅ Handoff fixed after ${iter} pass(es). Ticket #${ticket.id} marked as done.`;
        if (params.auto_next !== false) {
          text += queueNextTicketSession(pi, doneTicket);
        }

        return {
          content: [{ type: "text", text }],
          details: { ticket: doneTicket },
        };
      }

      if (iter >= state.maxIterations) {
        state.status = "stopped";
        state.completedAt = new Date().toISOString();
        saveLoopState(ctx.cwd, state);

        pi.sendUserMessage([
          `⚠️ **HANDOFF LOOP STOPPED** — Max iterations (${state.maxIterations}) on #${ticket.id} "${ticket.title}"`,
          "",
          checklist,
          "",
          "Review manually and complete missing fields before closing.",
        ].join("\n"));

        return {
          content: [{ type: "text", text: `Max handoff iterations reached on #${ticket.id}. Loop stopped.` }],
          details: {},
        };
      }

      pi.sendUserMessage(
        [
          `🔁 **HANDOFF FIX LOOP** — #${ticket.id} "${ticket.title}" | Pass ${iter}/${state.maxIterations}`,
          "",
          checklist,
          "",
          "**To fix:**",
          `1. \`spec_flow_update(id: ${ticket.id}, <handoff_fields>)\` — set ONLY fields marked ❌`,
          `2. \`spec_flow_handoff_loop_done(ticket_id: ${ticket.id}, spec_file: \"${params.spec_file}\")\``,
        ].join("\n"),
        { deliverAs: "followUp" },
      );

      return {
        content: [{ type: "text", text: `${checks.filter((c) => !c.ok).length} handoff field(s) still missing on #${ticket.id}. Follow-up sent.` }],
        details: {},
      };
    },
  });

  // ── spec_flow_validate_tickets ───────────────────────────

  pi.registerTool({
    name: "spec_flow_validate_tickets",
    label: "Validate Tickets",
    description:
      "Validate all spec tickets for completeness and correctness. Returns issues grouped by severity.",
    promptSnippet:
      "spec_flow_validate_tickets(spec_file?)",
    promptGuidelines: [
      "Use after creating or editing tickets to verify they meet quality standards.",
      "Returns a structured report: passed boolean, score, issues per ticket.",
      "Critical issues (missing acceptance_criteria, verification, scope, phase) block completion.",
      "Warnings (dependency refs, checkpoint spacing, empty fields) don't block.",
    ],
    parameters: Type.Object({
      spec_file: Type.Optional(
        Type.String({
          description: "Optional spec file to validate source_section references",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      initTicketsStore(ctx.cwd);
      if (!ticketsExist()) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                passed: false,
                error: "No tickets store found. Run /spec-flow-init first.",
                issues: [],
              }),
            },
          ],
          details: {},
        };
      }

      const tickets = listTickets();
      if (tickets.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                passed: false,
                error: "No tickets found. Create tickets first.",
                issues: [],
              }),
            },
          ],
          details: {},
        };
      }

      const critical: string[] = [];
      const warnings: string[] = [];
      const validIds = new Set(tickets.map((t) => t.id));
      const phaseCheckpoints: Map<string, number[]> = new Map();

      // Phase ordering for checkpoint spacing analysis
      const phaseOrder = ["Foundation", "Core Features", "Polish"];

      const asString = (value: unknown): string => {
        if (typeof value === "string") return value;
        if (Array.isArray(value)) return value.join(",");
        if (value == null) return "";
        return String(value);
      };

      for (const t of tickets) {
        const label = `#${t.id} "${t.title}"`;
        const acceptanceCriteria = asString(t.acceptance_criteria);
        const verification = asString(t.verification);
        const description = asString(t.description);
        const dependencies = asString(t.dependencies);

        // Critical: missing acceptance_criteria
        if (acceptanceCriteria.trim().length === 0) {
          critical.push(`${label}: missing acceptance_criteria`);
        }

        // Critical: missing verification
        if (verification.trim().length === 0) {
          critical.push(`${label}: missing verification steps`);
        }

        // Critical: missing or invalid estimated_scope
        if (!t.estimated_scope || !["XS", "S", "M", "L"].includes(t.estimated_scope)) {
          critical.push(
            `${label}: missing or invalid estimated_scope (must be XS, S, M, or L)`,
          );
        }

        // Critical: missing phase
        if (!t.phase) {
          critical.push(`${label}: missing phase (Foundation, Core Features, or Polish)`);
        } else if (!phaseOrder.includes(t.phase)) {
          warnings.push(
            `${label}: unrecognized phase "${t.phase}" (expected Foundation, Core Features, or Polish)`,
          );
        }

        // Warning: empty description
        if (description.trim().length < 10) {
          warnings.push(`${label}: description is too short or empty`);
        }

        // Warning: dependencies reference invalid IDs
        if (dependencies.trim().length > 0 && dependencies.trim().toLowerCase() !== "none") {
          const refs = dependencies
            .split(/[,\s]+/)
            .filter((d) => d.length > 0);
          for (const ref of refs) {
            const depId = parseInt(ref, 10);
            if (isNaN(depId) || !validIds.has(depId)) {
              warnings.push(`${label}: dependency "${ref}" is not a valid ticket ID`);
            }
          }
        }

        // Track checkpoints per phase
        if (t.is_checkpoint && t.phase) {
          const list = phaseCheckpoints.get(t.phase) || [];
          list.push(t.id);
          phaseCheckpoints.set(t.phase, list);
        }
      }

      // Warning: phases without checkpoints (every 2-3 tickets needs one)
      for (const phase of phaseOrder) {
        const phaseTickets = tickets.filter((t) => t.phase === phase);
        if (phaseTickets.length >= 2) {
          const cpIds = (phaseCheckpoints.get(phase) || []).sort((a, b) => a - b);
          const phaseIds = phaseTickets
            .map((t) => t.id)
            .sort((a, b) => a - b);
          // Check if there's a checkpoint at position ~2-3
          if (cpIds.length === 0) {
            warnings.push(
              `Phase "${phase}" has ${phaseTickets.length} tickets but no checkpoints (recommend every 2-3 tickets)`,
            );
          }
        }
      }

      const passed = critical.length === 0;
      const score = tickets.length > 0
        ? Math.round(
            ((tickets.length - new Set(critical.map((c) => c.split(":")[0])).size) /
              tickets.length) *
              100,
          )
        : 0;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              passed,
              score,
              total: tickets.length,
              critical_count: critical.length,
              warning_count: warnings.length,
              critical,
              warnings,
            }),
          },
        ],
        details: { passed, critical, warnings },
      };
    },
  });

  // ── spec_flow_ticket_loop_done ───────────────────────────
  //  Per-ticket loop: validates ONE ticket at a time.
  //  If it passes → LLM creates the next ticket and calls done again.
  //  If it fails → loop on that ticket until fixed or max iterations.

  pi.registerTool({
    name: "spec_flow_ticket_loop_done",
    label: "Tick Loop Done",
    description:
      "Validate ONE specific ticket. If it passes, create the next ticket. If it fails, fix it and call again. Loop stops when the ticket passes or max_iterations is reached.",
    promptSnippet:
      "spec_flow_ticket_loop_done(ticket_id, spec_file, max_iterations?)",
    promptGuidelines: [
      "Call after creating a single ticket to validate it before moving on.",
      "If the ticket passes → create the next ticket, then call this tool again with the new ticket_id.",
      "If the ticket fails → a fix loop starts. Use `spec_flow_update` to fix only the failing fields, then call this tool again with the same ticket_id.",
      "DO NOT delete and recreate — use spec_flow_update to edit the existing ticket.",
      "Loop auto-stops when ticket passes or max_iterations (default 3) reached.",
      "After ALL tickets pass individually, run spec_flow_validate_tickets for cross-cutting checks.",
    ],
    parameters: Type.Object({
      ticket_id: Type.Number({
        description: "The ID of the ticket to validate",
      }),
      spec_file: Type.String({
        description: "The spec file name, used to name the loop state",
      }),
      max_iterations: Type.Optional(
        Type.Number({
          description: "Max fix iterations for this ticket (default: 3).",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const maxIter = params.max_iterations ?? 3;
      let state = loadLoopState(ctx.cwd);
      const loopName = params.spec_file;

      if (ctx.hasPendingMessages()) {
        return {
          content: [{ type: "text", text: "Pending messages already queued. Call again after processing them." }],
          details: {},
        };
      }

      if (state && state.status === "active" && state.name !== loopName) {
        return {
          content: [{
            type: "text",
            text: `Another loop is active (${state.name}). Finish it first before validating ticket #${params.ticket_id}.`,
          }],
          details: {},
        };
      }

      initTicketsStore(ctx.cwd);
      const ticket = getTicket(params.ticket_id);
      if (!ticket) {
        return {
          content: [{ type: "text", text: `Ticket #${params.ticket_id} not found. Create it first with spec_flow_create.` }],
          details: {},
        };
      }

      // Validate this specific ticket — point by point
      type CheckResult = { field: string; ok: boolean; value: string; help: string };
      const checks: CheckResult[] = [
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

      const passed = checks.every((c) => c.ok);

      function buildChecklist(): string {
        const lines = [
          `## Validation for #${params.ticket_id} "${ticket.title}"`,
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

      // ── No active loop → first validation of this ticket ──
      if (!state || state.status !== "active") {
        if (passed) {
          return {
            content: [{
              type: "text",
              text: buildChecklist() + `\n\n✅ Ticket #${params.ticket_id} passes. Create the next ticket and call spec_flow_ticket_loop_done again.`,
            }],
            details: {},
          };
        }

        // Start fix loop on this ticket
        state = createLoopState(ctx.cwd, loopName, maxIter);
        state.iteration++; // first pass done
        saveLoopState(ctx.cwd, state);

        const prompt = [
          `🔁 **FIX LOOP** — #${params.ticket_id} (1/${maxIter})`,
          "",
          buildChecklist(),
          "",
          `**To fix:**`,
          `1. Re-read the spec file (\`${params.spec_file}\`) to recall section details`,
          `2. \`spec_flow_update(${params.ticket_id}, <fields>)\` — set ONLY the fields marked ❌ (keep ✅ as-is)`,
          `3. \`spec_flow_ticket_loop_done(${params.ticket_id}, "${params.spec_file}")\` — same ticket ID, no delete needed`,
        ].join("\n");
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });

        return {
          content: [{ type: "text", text: `${checks.filter(c => !c.ok).length} field(s) missing on #${params.ticket_id}. Fix loop started.` }],
          details: {},
        };
      }

      // ── Active loop: advance iteration ──
      state.iteration++;
      saveLoopState(ctx.cwd, state);

      const iter = state.iteration - 1;

      if (passed) {
        state.status = "completed";
        state.completedAt = new Date().toISOString();
        saveLoopState(ctx.cwd, state);
        return {
          content: [{
            type: "text",
            text: buildChecklist() + `\n\n✅ Ticket #${params.ticket_id} fixed after ${iter} pass(es). Create the next ticket and call spec_flow_ticket_loop_done again.`,
          }],
          details: {},
        };
      }

      if (iter >= state.maxIterations) {
        state.status = "stopped";
        state.completedAt = new Date().toISOString();
        saveLoopState(ctx.cwd, state);
        pi.sendUserMessage([
          `⚠️ **FIX LOOP STOPPED** — Max iterations (${state.maxIterations}) on #${params.ticket_id} "${ticket.title}"`,
          "",
          buildChecklist(),
          "",
          "Review manually.",
        ].join("\n"));
        return {
          content: [{ type: "text", text: `Max iterations on #${params.ticket_id}. Loop stopped.` }],
          details: {},
        };
      }

      // Still failing, try again
      pi.sendUserMessage(
        [
          `🔁 **FIX LOOP** — #${params.ticket_id} "${ticket.title}" | Pass ${iter}/${state.maxIterations}`,
          "",
          buildChecklist(),
          "",
          `**To fix:**`,
          `1. Re-read the spec file (\`${params.spec_file}\`) to recall section details`,
          `2. \`spec_flow_update(${params.ticket_id}, <fields>)\` — set ONLY the fields marked ❌ (keep ✅ as-is)`,
          `3. \`spec_flow_ticket_loop_done(${params.ticket_id}, "${params.spec_file}")\` — same ticket ID, no delete needed`,
        ].join("\n"),
        { deliverAs: "followUp" },
      );
      return {
        content: [{ type: "text", text: `${checks.filter(c => !c.ok).length} field(s) missing on #${params.ticket_id}. Follow-up sent.` }],
        details: {},
      };
    },
  });
}
