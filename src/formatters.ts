/**
 * Ticket formatting helpers for spec-flow extension.
 */
import type { Ticket } from "./tickets-fs.js";

// ── Scope label width padding ───────────────────────────────

const SCOPE_WIDTH: Record<string, string> = {
  XS: "XS ",
  S:  "S  ",
  M:  "M  ",
  L:  "L  ",
  XL: "XL ",
};

// ── Helpers ─────────────────────────────────────────────────

function statusIcon(status: string): string {
  if (status === "done") return "✓";
  if (status === "in_progress") return "▶";
  return "○";
}

// ── Public ──────────────────────────────────────────────────

/**
 * Format a ticket as a compact single-line summary.
 */
export function formatTicketCompact(t: Ticket): string {
  const icon = statusIcon(t.status);
  const scope = t.estimated_scope
    ? ` [${SCOPE_WIDTH[t.estimated_scope] ?? t.estimated_scope}]`
    : "";
  const phase = t.phase ? ` (${t.phase})` : "";
  const cp = t.is_checkpoint ? " ⚑CHECKPOINT" : "";
  return `  ${icon} #${t.id}${scope} [${t.status}]${phase}${cp} ${t.title}`;
}

/**
 * Format a ticket as a full multi-line detail view.
 */
export function formatTicketFull(t: Ticket): string {
  const lines: string[] = [];
  lines.push(`**#${t.id} — ${t.title}** [${t.status}]`);

  if (t.phase) lines.push(`Phase: ${t.phase}${t.is_checkpoint ? " (CHECKPOINT)" : ""}`);
  if (t.estimated_scope) lines.push(`Scope: ${t.estimated_scope}`);
  if (t.dependencies) lines.push(`Dependencies: ${t.dependencies}`);

  lines.push("");
  lines.push(t.description || "(no description)");

  if (t.acceptance_criteria) {
    lines.push("");
    lines.push("**Acceptance Criteria:**");
    lines.push(t.acceptance_criteria);
  }

  if (t.verification) {
    lines.push("");
    lines.push("**Verification:**");
    lines.push(t.verification);
  }

  if (t.files_touched) {
    lines.push("");
    lines.push(`**Files:** ${t.files_touched}`);
  }

  if (t.risks) {
    lines.push("");
    lines.push(`**Risks:** ${t.risks}`);
  }

  if (t.open_questions) {
    lines.push("");
    lines.push(`**Open Questions:** ${t.open_questions}`);
  }

  if (t.source_spec_path) {
    lines.push("");
    lines.push(`**Source Spec:** ${t.source_spec_path}`);
  }

  const hasHandoff = !!(
    t.handoff_summary ||
    t.handoff_files ||
    t.handoff_decisions ||
    t.handoff_verification ||
    t.handoff_risks ||
    t.handoff_next_ticket
  );

  if (hasHandoff) {
    lines.push("");
    lines.push("**Implementation Handoff:**");
    if (t.handoff_summary) lines.push(`- Summary: ${t.handoff_summary}`);
    if (t.handoff_files) lines.push(`- Files changed: ${t.handoff_files}`);
    if (t.handoff_decisions) lines.push(`- Decisions: ${t.handoff_decisions}`);
    if (t.handoff_verification) lines.push(`- Verification result: ${t.handoff_verification}`);
    if (t.handoff_risks) lines.push(`- Pending risks: ${t.handoff_risks}`);
    if (t.handoff_next_ticket) lines.push(`- Next ticket: ${t.handoff_next_ticket}`);
  }

  lines.push("");
  lines.push(`Feature: ${t.feature_key} → ${t.source_section}`);
  lines.push(`Created: ${t.created_at} | Updated: ${t.updated_at}`);

  return lines.join("\n");
}
