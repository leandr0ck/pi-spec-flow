/**
 * spec-flow tools — planning + implementation closeout loops
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  initTicketsStore,
  ensureTicketsStore,
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
import { formatTicketCompact, formatTicketFull } from "./formatters.js";
import {
  loadLoopState,
  saveLoopState,
  createLoopState,
} from "./ticket-loop.js";
import {
  getBlockForTicket,
  getNextTicketAfterBlock,
  getNextTicketInBlock,
} from "./checkpoints.js";
import {
  type CheckpointHandoffSections,
  createCheckpointHandoff,
  renderCheckpointHandoffContent,
  saveCheckpointHandoff,
} from "./checkpoint-handoffs.js";
import { loadPlanningContext } from "./planning-context.js";
import { armTicketValidation } from "./ticket-validation-runner.js";
import {
  recordCheckpointHandoffSaved,
  recordImplementationTicketDone,
} from "./implementation-flow-runner.js";

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

function missingFieldNames(checks: Array<{ field: string; ok: boolean }>): string[] {
  return checks.filter((check) => !check.ok).map((check) => check.field);
}

function conciseFixInstruction(
  ticketId: number,
  missingFields: string[],
  closeCommand: string,
): string {
  return [
    `Missing fields on #${ticketId}: ${missingFields.join(", ")}.`,
    `Update only those fields, then call: ${closeCommand}`,
  ].join("\n");
}

function getTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  const textPart = result.content?.find(
    (part): part is { type: "text"; text: string } =>
      part.type === "text" && typeof part.text === "string",
  );
  return textPart?.text ?? "";
}

function renderCompactResult(
  result: { content?: Array<{ type: string; text?: string }>; details?: unknown },
  expanded: boolean,
  theme: { fg: (token: any, text: string) => string },
): Text {
  const details = (result.details ?? {}) as {
    summary?: string;
    checklist?: string;
    ticket_preview?: string;
  };

  if (!expanded) {
    const summary = details.summary ?? getTextContent(result);
    return new Text(summary ? theme.fg("toolOutput", summary) : "", 0, 0);
  }

  const expandedText = details.checklist ?? details.ticket_preview ?? getTextContent(result);
  return new Text(expandedText ? `\n${theme.fg("toolOutput", expandedText)}` : "", 0, 0);
}

function normalizeSectionEntries(entries: string[]): string[] {
  return entries.map((entry) => entry.trim()).filter(Boolean);
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
      "spec_flow_create(title, description, source_section, feature_key, source_spec_path?, acceptance_criteria?, verification?, dependencies?, files_touched?, estimated_scope?, phase?, is_checkpoint?, risks?, open_questions?, order_index?)",
    promptGuidelines: [
      "Use spec_flow_create after /spec-flow-init; include source_spec_path, acceptance_criteria, verification, XS/S/M/L scope, phase, and dependencies.",
      "Use checkpoint tickets every 2-3 tasks and at phase boundaries.",
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
      feature_key: Type.String({
        description: "Feature key/folder for the ticket set, e.g. 'checkout' or 'new-arch'",
      }),
      source_spec_path: Type.Optional(
        Type.String({
          description: "Real spec document path, e.g. 'docs/implementation-spec.md'",
        })
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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sourceSpecPath =
        params.source_spec_path ??
        loadPlanningContext(ctx.cwd, params.feature_key)?.sourceSpecPath ??
        undefined;
      initTicketsStore(ctx.cwd, sourceSpecPath);
      if (!ticketsExist()) {
        if (sourceSpecPath) {
          ensureTicketsStore();
        } else {
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
      }

      const input: CreateTicketInput = {
        title: params.title,
        description: params.description,
        source_section: params.source_section,
        feature_key: params.feature_key,
        source_spec_path: sourceSpecPath,
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
      armTicketValidation(pi, ticket);
      const summary = formatTicketCompact(ticket);
      return {
        content: [{ type: "text", text: `Created ${summary}. Ticket validation armed.` }],
        details: {
          ticket,
          summary: `✓ Created #${ticket.id} ${ticket.title}`,
          ticket_preview: formatTicketFull(ticket),
        },
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("spec_flow_create"))} ${theme.fg("accent", args.title ?? "")}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      return renderCompactResult(result, expanded, theme);
    },
  });

  // ── spec_flow_update ──────────────────────────────────────

  pi.registerTool({
    name: "spec_flow_update",
    label: "Spec Flow Update",
    description:
      "Update a spec ticket's status and/or fields. Use to mark progress, fix validation issues, or edit any ticket field without recreating it.",
    promptSnippet:
      "spec_flow_update(id: number, status?, auto_next?, title?, description?, feature_key?, source_spec_path?, acceptance_criteria?, verification?, ...)",
    promptGuidelines: [
      "Use spec_flow_update to patch changed fields and fill handoff fields before closing; ticket kickoff marks in_progress automatically.",
      "Use auto_next:false only when you do not want the default same-block/checkpoint chaining.",
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
            "When status='done': true (default) continues within the current block or opens the next block session; false disables auto-chain",
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
      feature_key: Type.Optional(
        Type.String({ description: "Feature key/folder, e.g. 'checkout' or 'new-arch'" })
      ),
      source_spec_path: Type.Optional(
        Type.String({ description: "Real spec document path, e.g. 'docs/implementation-spec.md'" })
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
      initTicketsStore(ctx.cwd, params.source_spec_path);
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
      if (params.feature_key !== undefined) fields.feature_key = params.feature_key;
      if (params.source_spec_path !== undefined) fields.source_spec_path = params.source_spec_path;
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
          const missingFields = missingFieldNames(handoffChecks);
          pi.sendUserMessage(
            [
              `🔁 **HANDOFF REQUIRED** — #${updatedWithoutDone.id} "${updatedWithoutDone.title}" was not marked done.`,
              conciseFixInstruction(
                updatedWithoutDone.id,
                missingFields,
                `spec_flow_handoff_loop_done(ticket_id: ${updatedWithoutDone.id}, feature_key: "${updatedWithoutDone.feature_key}")`,
              ),
            ].join("\n"),
            { deliverAs: "followUp" },
          );

          return {
            content: [
              {
                type: "text",
                text: `Ticket #${updatedWithoutDone.id} not marked done. Missing: ${missingFields.join(", ")}.`,
              },
            ],
            details: { ticket: updatedWithoutDone, missing_handoff: missingFields, checklist },
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
        recordImplementationTicketDone(pi, updated, true);
        text += "\nImplementation flow recorded; continuation will run after this turn.";
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
      "spec_flow_handoff_loop_done(ticket_id, feature_key, max_iterations?)",
    promptGuidelines: [
      "Use spec_flow_handoff_loop_done to close implementation tickets after handoff fields are filled; fix missing fields with spec_flow_update, never recreate tickets.",
      "Passing tickets auto-chain within the block; checkpoints request structured checkpoint handoff before the next block.",
    ],
    parameters: Type.Object({
      ticket_id: Type.Number({
        description: "The ID of the ticket to close",
      }),
      feature_key: Type.String({
        description: "Feature key/folder, used to scope loop state",
      }),
      max_iterations: Type.Optional(
        Type.Number({
          description: "Max fix iterations for this ticket (default: 3).",
        }),
      ),
      auto_next: Type.Optional(
        Type.Boolean({
          description: "When done: true (default) continues within the current block or opens the next block session; false disables auto-chain",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const maxIter = params.max_iterations ?? 3;
      const loopName = `handoff:${params.feature_key}:${params.ticket_id}`;
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

      initTicketsStore(ctx.cwd, loadPlanningContext(ctx.cwd, params.feature_key)?.sourceSpecPath);
      const ticket = getTicket(params.ticket_id);
      if (!ticket) {
        return {
          content: [{ type: "text", text: `Ticket #${params.ticket_id} not found.` }],
          details: {},
        };
      }


      // ── Auto-fill handoff_next_ticket if empty ──
      if (!ticket.handoff_next_ticket?.trim()) {
        const orderedTickets = listTicketsForSpec(ticket.feature_key);
        const nextInBlock = getNextTicketInBlock(orderedTickets, ticket.id);
        const nextAfterBlock = getNextTicketAfterBlock(orderedTickets, ticket.id);
        const recommended = nextInBlock
          ? `#${nextInBlock.id}`
          : nextAfterBlock
            ? `#${nextAfterBlock.id}`
            : "None";
        updateTicket(ticket.id, { handoff_next_ticket: recommended });
        ticket.handoff_next_ticket = recommended;
      }

      const checks = buildHandoffChecks(ticket);
      const passed = checks.every((c) => c.ok);
      const checklist = buildHandoffChecklist(ticket, checks);
      const missingFields = missingFieldNames(checks);

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

          let text = `✅ Handoff complete. Ticket #${ticket.id} marked as done.`;
          if (params.auto_next !== false) {
            recordImplementationTicketDone(pi, doneTicket, true);
            text += "\nImplementation flow recorded; continuation will run after this turn.";
          }

          return {
            content: [{ type: "text", text }],
            details: { ticket: doneTicket, checklist },
          };
        }

        state = createLoopState(ctx.cwd, loopName, maxIter);
        state.iteration++; // first pass done
        saveLoopState(ctx.cwd, state);

        const prompt = [
          `🔁 **HANDOFF FIX LOOP** — #${ticket.id} (1/${maxIter})`,
          conciseFixInstruction(
            ticket.id,
            missingFields,
            `spec_flow_handoff_loop_done(ticket_id: ${ticket.id}, feature_key: "${params.feature_key}")`,
          ),
        ].join("\n");
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });

        return {
          content: [{ type: "text", text: `Missing handoff fields on #${ticket.id}: ${missingFields.join(", ")}.` }],
          details: { checklist, missing_handoff: missingFields },
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

        let text = `✅ Handoff fixed after ${iter} pass(es). Ticket #${ticket.id} marked as done.`;
        if (params.auto_next !== false) {
          recordImplementationTicketDone(pi, doneTicket, true);
          text += "\nImplementation flow recorded; continuation will run after this turn.";
        }

        return {
          content: [{ type: "text", text }],
          details: { ticket: doneTicket, checklist },
        };
      }

      if (iter >= state.maxIterations) {
        state.status = "stopped";
        state.completedAt = new Date().toISOString();
        saveLoopState(ctx.cwd, state);

        pi.sendUserMessage([
          `⚠️ **HANDOFF LOOP STOPPED** — Max iterations (${state.maxIterations}) on #${ticket.id} "${ticket.title}"`,
          `Still missing: ${missingFields.join(", ")}. Review manually before closing.`,
        ].join("\n"));

        return {
          content: [{ type: "text", text: `Max handoff iterations reached on #${ticket.id}. Loop stopped.` }],
          details: { checklist, missing_handoff: missingFields },
        };
      }

      pi.sendUserMessage(
        [
          `🔁 **HANDOFF FIX LOOP** — #${ticket.id} "${ticket.title}" | Pass ${iter}/${state.maxIterations}`,
          conciseFixInstruction(
            ticket.id,
            missingFields,
            `spec_flow_handoff_loop_done(ticket_id: ${ticket.id}, feature_key: "${params.feature_key}")`,
          ),
        ].join("\n"),
        { deliverAs: "followUp" },
      );

      return {
        content: [{ type: "text", text: `Still missing handoff fields on #${ticket.id}: ${missingFields.join(", ")}.` }],
        details: { checklist, missing_handoff: missingFields },
      };
    },
    renderResult(result, { expanded }, theme) {
      return renderCompactResult(result, expanded, theme);
    },
  });

  pi.registerTool({
    name: "spec_flow_checkpoint_handoff_save",
    label: "Checkpoint Handoff Save",
    description:
      "Save the checkpoint handoff file using a fixed extension template. Use after a checkpoint closes; provide structured section values only.",
    promptSnippet:
      "spec_flow_checkpoint_handoff_save(checkpoint_ticket_id, feature_key, summary, key_outcomes, files_changed, key_decisions, verification, open_risks, next_recommended_ticket?)",
    promptGuidelines: [
      "Use spec_flow_checkpoint_handoff_save immediately after closing a checkpoint; pass concise structured fields based only on ticket handoffs.",
    ],
    parameters: Type.Object({
      checkpoint_ticket_id: Type.Number({ description: "Checkpoint ticket ID for the block" }),
      feature_key: Type.String({ description: "Feature key/folder" }),
      summary: Type.String({ description: "One concise status summary for the completed block" }),
      key_outcomes: Type.Array(Type.String({ description: "Outcome bullet" }), {
        description: "Key outcomes achieved in the block",
      }),
      files_changed: Type.Array(Type.String({ description: "Changed file or path area" }), {
        description: "Files or areas changed in the block",
      }),
      key_decisions: Type.Array(Type.String({ description: "Decision with rationale" }), {
        description: "Key technical or product decisions",
      }),
      verification: Type.Array(Type.String({ description: "Verification result" }), {
        description: "Tests, commands, or manual verification with result",
      }),
      open_risks: Type.Array(Type.String({ description: "Open risk or TODO" }), {
        description: "Outstanding risks; use an empty array if none",
      }),
      next_recommended_ticket: Type.Optional(
        Type.String({ description: "Recommended next ticket, e.g. '#7' or 'None'" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      initTicketsStore(ctx.cwd, loadPlanningContext(ctx.cwd, params.feature_key)?.sourceSpecPath);
      if (!ticketsExist()) {
        return {
          content: [{ type: "text", text: "No tickets store found." }],
          details: {},
        };
      }

      const ticket = getTicket(params.checkpoint_ticket_id);
      if (!ticket) {
        return {
          content: [{ type: "text", text: `Ticket #${params.checkpoint_ticket_id} not found.` }],
          details: {},
        };
      }

      if (ticket.feature_key !== params.feature_key) {
        return {
          content: [{ type: "text", text: `Ticket #${ticket.id} belongs to \"${ticket.feature_key}\", not \"${params.feature_key}\".` }],
          details: {},
        };
      }

      if (!ticket.is_checkpoint) {
        return {
          content: [{ type: "text", text: `Ticket #${ticket.id} is not a checkpoint.` }],
          details: {},
        };
      }

      if (ticket.status !== "done") {
        return {
          content: [{ type: "text", text: `Checkpoint ticket #${ticket.id} must be done before saving its block handoff.` }],
          details: {},
        };
      }

      const orderedTickets = listTicketsForSpec(ticket.feature_key);
      const block = getBlockForTicket(orderedTickets, ticket.id);
      if (!block) {
        return {
          content: [{ type: "text", text: `Could not resolve block for checkpoint #${ticket.id}.` }],
          details: {},
        };
      }

      if (block.checkpointTicket?.id !== ticket.id) {
        return {
          content: [{ type: "text", text: `Ticket #${ticket.id} is not the closing checkpoint for its block.` }],
          details: {},
        };
      }

      const nextAfterBlock = getNextTicketAfterBlock(orderedTickets, ticket.id);
      const sections: CheckpointHandoffSections = {
        summary: params.summary.trim(),
        keyOutcomes: normalizeSectionEntries(params.key_outcomes),
        filesChanged: normalizeSectionEntries(params.files_changed),
        keyDecisions: normalizeSectionEntries(params.key_decisions),
        verification: normalizeSectionEntries(params.verification),
        openRisks: normalizeSectionEntries(params.open_risks).filter((entry) => !/^none$/i.test(entry)),
        nextRecommendedTicket:
          params.next_recommended_ticket?.trim() || (nextAfterBlock ? `#${nextAfterBlock.id}` : "None"),
      };

      if (!sections.summary) {
        return {
          content: [{ type: "text", text: "checkpoint handoff save failed: summary is required." }],
          details: {},
        };
      }

      const content = renderCheckpointHandoffContent(block.tickets, sections);
      saveCheckpointHandoff(ctx.cwd, createCheckpointHandoff(block.tickets, content));

      let text = `Checkpoint handoff saved for #${ticket.id}.`;
      recordCheckpointHandoffSaved(pi, ticket, true);
      text += "\nImplementation flow recorded; review or next-block guidance will run after this turn.";

      return {
        content: [{ type: "text", text }],
        details: {
          summary: `✓ Saved checkpoint handoff for #${ticket.id}`,
          checkpoint_ticket_id: ticket.id,
          content,
        },
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
      "spec_flow_validate_tickets(feature_key?)",
    promptGuidelines: [
      "Use after creating or editing tickets to verify they meet quality standards.",
      "Returns a structured report: passed boolean, score, issues per ticket.",
      "Critical issues (missing source_spec_path, acceptance_criteria, verification, scope, phase) block completion.",
      "Warnings (dependency refs, checkpoint spacing, empty fields) don't block.",
    ],
    parameters: Type.Object({
      feature_key: Type.Optional(
        Type.String({
          description: "Optional feature key/folder to validate",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sourceSpecPath = params.feature_key
        ? loadPlanningContext(ctx.cwd, params.feature_key)?.sourceSpecPath
        : null;
      initTicketsStore(ctx.cwd, sourceSpecPath);
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

      const tickets = params.feature_key
        ? listTicketsForSpec(params.feature_key)
        : listTickets();
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
        const sourceSpecPath = asString(t.source_spec_path);
        const acceptanceCriteria = asString(t.acceptance_criteria);
        const verification = asString(t.verification);
        const description = asString(t.description);
        const dependencies = asString(t.dependencies);

        if (sourceSpecPath.trim().length === 0) {
          critical.push(`${label}: missing source_spec_path (real source spec path)`);
        }

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

      }

      const specFiles = params.feature_key
        ? [params.feature_key]
        : Array.from(new Set(tickets.map((t) => t.feature_key))).sort();

      for (const specFile of specFiles) {
        const orderedTickets = listTicketsForSpec(specFile);

        for (const phase of phaseOrder) {
          const phaseTickets = orderedTickets.filter((t) => t.phase === phase);
          if (phaseTickets.length === 0) continue;

          const workTickets = phaseTickets.filter((t) => !t.is_checkpoint);
          const checkpointTickets = phaseTickets.filter((t) => t.is_checkpoint);

          if (workTickets.length >= 2 && checkpointTickets.length === 0) {
            warnings.push(
              `Feature "${specFile}" phase "${phase}" has ${workTickets.length} work tickets but no checkpoints (recommend every 2-3 tasks and at phase boundaries)`,
            );
            continue;
          }

          let workTicketsSinceCheckpoint = 0;

          for (const ticket of phaseTickets) {
            if (ticket.is_checkpoint) {
              if (workTicketsSinceCheckpoint === 0) {
                warnings.push(
                  `Feature "${specFile}" phase "${phase}" has checkpoint #${ticket.id} without preceding work tickets`,
                );
              } else if (workTicketsSinceCheckpoint > 3) {
                warnings.push(
                  `Feature "${specFile}" phase "${phase}" delays checkpoint #${ticket.id} until after ${workTicketsSinceCheckpoint} work tickets (recommend every 2-3 tasks)`,
                );
              }

              workTicketsSinceCheckpoint = 0;
              continue;
            }

            workTicketsSinceCheckpoint += 1;
          }

          if (checkpointTickets.length > 0 && workTicketsSinceCheckpoint > 0) {
            warnings.push(
              `Feature "${specFile}" phase "${phase}" ends with ${workTicketsSinceCheckpoint} trailing work tickets after the last checkpoint. Add a closing checkpoint before moving on.`,
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

      const criticalForModel = critical.slice(0, 10);
      const warningsForModel = warnings.slice(0, 10);

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
              critical: criticalForModel,
              warnings: warningsForModel,
              truncated: critical.length > criticalForModel.length || warnings.length > warningsForModel.length,
            }),
          },
        ],
        details: { passed, critical, warnings },
      };
    },
  });


}
