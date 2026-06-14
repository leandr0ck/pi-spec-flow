---
name: spec-flow-implementation-protocol
description: >-
  Stable implementation workflow for pi-spec-flow tickets. Use when a
  spec-flow ticket kickoff says to follow the implementation protocol, when
  working a current ticket, filling ticket handoff fields, closing with
  spec_flow_handoff_loop_done, or saving checkpoint handoffs.
user-invocable: false
auto-trigger: false
trigger_keywords:
  - spec-flow implementation protocol
  - spec_flow_handoff_loop_done
  - spec_flow_checkpoint_handoff_save
---

# Spec Flow Implementation Protocol

Use this protocol for the current ticket only.

## Ticket workflow

The extension marks the current ticket `in_progress` when it opens or queues the ticket. Do not spend a tool call on that unless the ticket was opened outside the spec-flow kickoff path.

1. Implement only the current ticket scope and its explicit dependencies.
2. Verify using the ticket's verification steps.
3. Fill handoff fields with `spec_flow_update`:
   - `handoff_summary`: 3–5 bullets on what changed
   - `handoff_files`: files actually changed
   - `handoff_decisions`: key decisions and rationale
   - `handoff_verification`: commands/tests/manual checks and result
   - `handoff_risks`: pending risks/TODOs or `None`
   - `handoff_next_ticket`: recommended next ticket or `None`
4. Close with `spec_flow_handoff_loop_done` using the current ticket ID and feature key.

## Checkpoints

When a checkpoint ticket closes, call `spec_flow_checkpoint_handoff_save` as the next action if requested by the extension.

Base checkpoint summaries only on ticket handoff evidence. Do not write a freeform handoff file in chat.

## Context discipline

- Prefer grep/search before reading full files.
- Load only the smallest code context needed.
- Do not pull unrelated tickets or old blocks into context unless the previous checkpoint handoff or explicit dependencies require it.
