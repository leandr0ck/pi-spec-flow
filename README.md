# pi-spec-flow

A Pi extension for **spec-driven development with controlled context**.

`pi-spec-flow` turns a technical spec into small, validated Markdown tickets and then drives implementation ticket-by-ticket or block-by-block. It is designed for developers who want the benefits of spec-first work without letting every coding session carry the entire spec, backlog, and history in context.

## Why use it?

AI coding works better when the agent has:

- a clear spec before implementation starts
- small implementation units with acceptance criteria
- explicit verification steps
- isolated context per ticket or checkpoint block
- persisted handoffs instead of relying on chat memory

`pi-spec-flow` provides that workflow inside Pi.

It helps you:

- convert a `spec.md` into implementation-ready tickets
- validate each ticket before coding begins
- keep tickets as Markdown files in your repo
- open fresh implementation sessions with only the relevant ticket context
- capture structured handoffs after each ticket
- optionally pause at checkpoints for block-level synthesis and review

## Install

```bash
pi install npm:pi-spec-flow@latest
```

Pi auto-discovers the extension through the `pi.extensions` entry in `package.json`.

## Configuration

Create `spec-flow.config.json` in your project root:

```json
{
  "$schema": "./spec-flow.schema.json",
  "ticketsFolder": "./docs/features",
  "checkpointReview": {
    "enabled": false,
    "model": "claude-sonnet-4-20250514",
    "thinkingLevel": "high",
    "skills": ["code-reviewer", "senior-security"]
  }
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ticketsFolder` | string | `./docs/features` | Directory where ticket Markdown files are stored |
| `checkpointReview.enabled` | boolean | `false` | Enable automatic code review after checkpoint tickets |
| `checkpointReview.model` | string | — | Model to use for the review message |
| `checkpointReview.thinkingLevel` | string | `medium` | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `checkpointReview.skills` | string[] | `[]` | Skills to request for review, e.g. `code-reviewer`, `senior-security` |


## Quick start

```text
1. Write a spec:       docs/my-feature-spec.md
2. Plan tickets:       /spec-flow-init docs/my-feature-spec.md --feature=my-feature
3. Start coding:       /spec-flow-implement --feature=my-feature
```

That gives you a loop like this:

```text
Spec → validated tickets → isolated implementation sessions → structured handoffs → next ticket/block
```

## Core workflow

### 1) Write a technical spec

Create a Markdown spec with `##` sections. The extension uses these sections to help the LLM break the work into sequenced tickets.

Example:

```markdown
# Checkout Improvements

## Payment validation
...

## Error states
...

## Confirmation page
...
```

### 2) Generate validated tickets

```text
/spec-flow-init <spec.md> [--feature <feature-key>]
```

Example:

```text
/spec-flow-init docs/checkout-spec.md --feature=checkout
```

The command loads the spec and asks the LLM to create tickets one at a time using `spec_flow_create`. After each created ticket, the extension validates it automatically and either prompts for targeted fixes or allows the next ticket to be created.

Each ticket must include:

- acceptance criteria
- verification steps
- source spec path
- phase: `Foundation`, `Core Features`, or `Polish`
- estimated scope: `XS`, `S`, `M`, or `L`
- dependencies, risks, and likely files touched when relevant

Checkpoint tickets are added every 2–3 tasks and at phase boundaries.

### 3) Implement with optimized context

```text
/spec-flow-implement [--feature <feature-key>]
```

or:

```text
/spec-flow-next --new --feature=<feature-key>
```

Implementation starts in a fresh session for the next relevant ticket/block. This is the main context-management benefit: the agent does not need to carry the whole planning conversation forward. It gets the current ticket, the current block, and the previous checkpoint handoff when needed.

### 4) Close tickets with a structured handoff

For each ticket, the implementation session follows this pattern:

```text
1. Mark in progress:
   spec_flow_update(id: X, status: "in_progress")

2. Implement only the ticket scope.

3. Fill handoff fields:
   spec_flow_update(
     id: X,
     handoff_summary: "...",
     handoff_files: "...",
     handoff_decisions: "...",
     handoff_verification: "...",
     handoff_risks: "None"
   )

4. Validate and close:
   spec_flow_handoff_loop_done(ticket_id: X, feature_key: "checkout")
```

If required handoff fields are missing, the extension starts a fix loop before marking the ticket done.

### 5) Use checkpoints to prevent context rot

Checkpoint tickets summarize a completed block of work. After a checkpoint closes, the extension asks for a structured checkpoint handoff and saves it automatically.

The next block starts from that concise handoff instead of from a long chat history.

## Ticket storage

Tickets are stored as Markdown files in:

```text
{ticketsFolder}/{feature-key}/*.md
```

Default:

```text
./docs/features
```

Each ticket keeps:

- `feature_key`: logical feature/folder name
- `source_spec_path`: original spec document path
- planning metadata
- implementation status
- handoff fields

Because tickets live in your repo, they can be reviewed, versioned, and resumed across sessions.

## Optional checkpoint code review

When `checkpointReview.enabled` is `true` in `spec-flow.config.json`, the extension automatically adds a review gate after each checkpoint.

**Hard lifecycle requirement:**

1. Implement the block tickets.
2. Implement/close the checkpoint ticket.
3. Save the checkpoint handoff.
4. If checkpoint review is configured, launch the review with the configured review model and thinking level.
5. Run the review against the completed block tickets and checkpoint handoff.
6. Show the review result to the user.
7. **FIN. Stop. Do not continue implementation. Do not start the next ticket. Do not run `/spec-flow-next`. Do not commit.**

The checkpoint review result is user-facing output only. It must not be injected as a follow-up instruction for the implementation agent to act on.

There is no separate manual review command; checkpoint review only runs from the automatic post-checkpoint flow when configured.

This is useful when you want a second-pass review of the code produced in the previous block without mixing that review context into the implementation session.

Recommended model format:

```json
{
  "checkpointReview": {
    "enabled": true,
    "model": "openai-codex/gpt-5.5",
    "thinkingLevel": "high",
    "skills": ["code-reviewer", "senior-security"]
  }
}
```

Use `provider/model` for `checkpointReview.model` when possible so the review subagent can select the model unambiguously. The implementation session should not continue after the review finishes.

Example review behavior:

```text
Starting checkpoint review for #5 using model: openai-codex/gpt-5.5; thinking level: high.
Checkpoint review completed for #5.
Review flow complete. The extension will not continue implementation or start the next ticket automatically.
```

## Recommended usage pattern

Use `pi-spec-flow` when the work is larger than a quick one-file change:

- new features
- multi-file refactors
- migrations
- API or data model changes
- work that needs acceptance criteria and verification
- work you may need to resume later

For very small fixes, a direct Pi session may be cheaper. For anything that risks context overload, start from a spec and let `pi-spec-flow` keep the context narrow.

## Flow diagram

```mermaid
flowchart TD
  A[Write spec.md] --> B[/spec-flow-init]
  B --> C[Create ticket with spec_flow_create]
  C --> D[Extension validates created ticket]
  D --> E{Ticket valid?}
  E -->|No| F[Fix with spec_flow_update]
  F --> D
  E -->|Yes| G{More tickets?}
  G -->|Yes| C
  G -->|No| H[spec_flow_validate_tickets]
  H --> I[Implementation: /spec-flow-implement]
  I --> J[Fresh session for ticket/block]
  J --> K[Implement and fill handoff]
  K --> L[spec_flow_handoff_loop_done]
  L --> M{Checkpoint?}
  M -->|Yes| N[Save checkpoint handoff]
  M -->|No| O[Continue next ticket]
  N --> P[Open next block with concise handoff]
```

## Commands

| Command | Description |
|---------|-------------|
| `/spec-flow-init <spec.md> [--feature <key>]` | Load a spec and guide ticket creation/validation |
| `/spec-flow-implement [--feature <key>]` | Start implementation block-by-block until each checkpoint |
| `/spec-flow-start [--feature <key>]` | Alias for `/spec-flow-implement` |
| `/spec-flow-next` | Show the next pending ticket in the current session |
| `/spec-flow-next --new` | Open the next pending ticket in a fresh session |
| `/spec-flow-next <id> --new` | Open a specific ticket in a fresh session |
| `/spec-flow-next --feature=<key>` | Scope next-ticket selection to one feature |

## Tools exposed to the LLM

| Tool | Purpose |
|------|---------|
| `spec_flow_create` | Create a structured ticket |
| `spec_flow_update` | Update ticket fields, status, or handoff data |
| `spec_flow_validate_tickets` | Validate all tickets for cross-cutting completeness |
| `spec_flow_handoff_loop_done` | Validate implementation handoff and close a ticket |
| `spec_flow_checkpoint_handoff_save` | Save a structured checkpoint/block handoff |

## Changelog

This changelog tracks **breaking changes only**. Do not update this section for additive features, bug fixes, documentation edits, or internal refactors that preserve the existing command/tool workflow.

### Breaking changes

- None recorded.
