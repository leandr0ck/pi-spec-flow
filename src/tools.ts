/**
 * spec-flow tools — spec_flow_create, spec_flow_query, spec_flow_update
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  initTicketsStore,
  ticketsExist,
  insertFullTicket,
  listTickets,
  getTicket,
  updateTicketStatus,
  deleteTicket,
  type Ticket,
  type CreateTicketInput,
} from "./tickets-fs.js";
import { formatTicketCompact, formatTicketFull } from "./formatters.js";
import {
  loadLoopState,
  saveLoopState,
  createLoopState,
} from "./ticket-loop.js";

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

  // ── spec_flow_query ───────────────────────────────────────

  pi.registerTool({
    name: "spec_flow_query",
    label: "Spec Flow Query",
    description:
      "Query spec tickets from the filesystem store. Use to see pending work, get ticket details, or check status.",
    promptSnippet:
      "spec_flow_query(action: 'list' | 'get', status?: 'pending' | 'in_progress' | 'done', id?: number)",
    promptGuidelines: [
      "Use spec_flow_query before starting new work to see what tickets are pending.",
      "Use spec_flow_query with action='get' and the ticket id to read full ticket context before implementing.",
      "Use spec_flow_update to mark a ticket as in_progress when starting work, and done when completed.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "get"] as const),
      status: Type.Optional(
        StringEnum(["pending", "in_progress", "done"] as const)
      ),
      id: Type.Optional(
        Type.Number({
          description: "Ticket ID (required for 'get' action)",
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
              text: "No tickets store found. Ask the user to run /spec-flow-init with a spec file.",
            },
          ],
          details: {},
        };
      }

      if (params.action === "get") {
        if (!params.id) {
          return {
            content: [
              { type: "text", text: "Missing ticket id for 'get' action." },
            ],
            details: {},
          };
        }
        const ticket = getTicket(params.id);
        if (!ticket) {
          return {
            content: [
              { type: "text", text: `Ticket #${params.id} not found.` },
            ],
            details: {},
          };
        }
        return {
          content: [{ type: "text", text: formatTicketFull(ticket) }],
          details: { ticket },
        };
      }

      // action === "list"
      const tickets = listTickets(params.status);
      if (tickets.length === 0) {
        const msg = params.status
          ? `No tickets with status "${params.status}".`
          : "No tickets found.";
        return {
          content: [{ type: "text", text: msg }],
          details: { tickets: [] },
        };
      }

      const lines = tickets.map(formatTicketCompact);
      const summary = `**${tickets.length} ticket(s)**${
        params.status ? ` (status: ${params.status})` : ""
      }:\n${lines.join("\n")}`;
      return {
        content: [{ type: "text", text: summary }],
        details: { tickets },
      };
    },
  });

  // ── spec_flow_update ──────────────────────────────────────

  pi.registerTool({
    name: "spec_flow_update",
    label: "Spec Flow Update",
    description:
      "Update a spec ticket's status. Mark as in_progress when starting work, done when completed.",
    promptSnippet:
      "spec_flow_update(id: number, status: 'pending' | 'in_progress' | 'done')",
    parameters: Type.Object({
      id: Type.Number({ description: "Ticket ID to update" }),
      status: StringEnum(
        ["pending", "in_progress", "done"] as const
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

      const updated = updateTicketStatus(
        params.id,
        params.status as "pending" | "in_progress" | "done"
      );
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
      const text = `Ticket #${updated.id} "${updated.title}" → ${updated.status}`;
      return {
        content: [{ type: "text", text }],
        details: { ticket: updated },
      };
    },
  });

  // ── spec_flow_delete ─────────────────────────────────────

  pi.registerTool({
    name: "spec_flow_delete",
    label: "Spec Flow Delete",
    description:
      "Delete a spec ticket by ID. Use when re-creating a ticket to fix validation issues — delete the old failing one first, then create the corrected version.",
    promptSnippet: "spec_flow_delete(id: number)",
    promptGuidelines: [
      "Use before re-creating a ticket with spec_flow_create when fixing validation issues.",
      "Deleting the old ticket ensures the loop doesn't re-validate the stale version.",
    ],
    parameters: Type.Object({
      id: Type.Number({ description: "Ticket ID to delete" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      initTicketsStore(ctx.cwd);
      if (!ticketsExist()) {
        return {
          content: [{ type: "text", text: "No tickets store found." }],
          details: {},
        };
      }
      const ok = deleteTicket(params.id);
      if (!ok) {
        return {
          content: [{ type: "text", text: `Ticket #${params.id} not found.` }],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: `Deleted ticket #${params.id}.` }],
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

      for (const t of tickets) {
        const label = `#${t.id} "${t.title}"`;

        // Critical: missing acceptance_criteria
        if (!t.acceptance_criteria || t.acceptance_criteria.trim().length === 0) {
          critical.push(`${label}: missing acceptance_criteria`);
        }

        // Critical: missing verification
        if (!t.verification || t.verification.trim().length === 0) {
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
        if (!t.description || t.description.trim().length < 10) {
          warnings.push(`${label}: description is too short or empty`);
        }

        // Warning: dependencies reference invalid IDs
        if (t.dependencies && t.dependencies.trim().toLowerCase() !== "none") {
          const refs = t.dependencies
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
      "If the ticket fails → a fix loop starts. Delete the old ticket, re-create it corrected, call again.",
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

      if (ctx.hasPendingMessages()) {
        return {
          content: [{ type: "text", text: "Pending messages already queued. Call again after processing them." }],
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
        state = createLoopState(ctx.cwd, params.spec_file, maxIter);
        state.iteration++; // first pass done
        saveLoopState(ctx.cwd, state);

        const prompt = [
          `🔁 **FIX LOOP** — #${params.ticket_id} (1/${maxIter})`,
          "",
          buildChecklist(),
          "",
          `**To fix:**`,
          `1. Re-read the spec file (\`${params.spec_file}\`) to recall section details`,
          `2. \`spec_flow_delete(${params.ticket_id})\``,
          `3. \`spec_flow_create\` with the corrected fields (keep what's green, fix what's red)`,
          `4. \`spec_flow_ticket_loop_done\` with the NEW ticket id`,
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
          `2. \`spec_flow_delete(${params.ticket_id})\``,
          `3. \`spec_flow_create\` with the corrected fields (keep what's green, fix what's red)`,
          `4. \`spec_flow_ticket_loop_done\` with the NEW ticket id`,
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
