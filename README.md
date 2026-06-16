# pi-spec-flow

`pi-spec-flow` is a Pi extension for **spec-driven AI coding with controlled context**.

It turns a product or technical spec into a sequenced implementation plan, then helps Pi work through that plan in small blocks with clear handoffs and optional checkpoint review.

The goal is simple: keep each coding session focused, reviewable, and easy to resume.

## Why use it?

AI coding agents are more reliable when they work from:

- a written spec
- small implementation steps
- explicit verification expectations
- fresh context at natural boundaries
- saved handoffs instead of chat-memory assumptions

`pi-spec-flow` gives you that workflow inside Pi.

Use it when a change is bigger than a quick one-file fix: new features, refactors, migrations, API changes, or work you may need to pause and resume later.

## Install

```bash
pi install npm:pi-spec-flow@latest
```

Restart Pi after installing.

## Quick start

```text
1. Write a spec:  docs/my-feature-spec.md
2. Plan work:     /spec-flow-init docs/my-feature-spec.md --feature=my-feature
3. Implement:     /spec-flow-implement --feature=my-feature
```

Typical flow:

```text
Spec → implementation plan → focused coding block → handoff → optional checkpoint review → next block
```

## Core workflow

### 1. Write a spec

Create a Markdown spec that describes the work and expected behavior.

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

### 2. Generate the implementation plan

Run:

```text
/spec-flow-init <spec.md> --feature=<feature-key>
```

Example:

```text
/spec-flow-init docs/checkout-spec.md --feature=checkout
```

Pi will read the spec and create a structured implementation plan stored in your repo as Markdown.

The extension validates the plan as it is created so implementation starts from clear, testable work instead of a vague backlog.

### 3. Implement block by block

Run:

```text
/spec-flow-implement --feature=<feature-key>
```

The extension starts the next implementation block and keeps the session focused on the relevant work. At checkpoint boundaries, it saves a concise handoff so the next block does not need the full prior chat history.

### 4. Review checkpoints when configured

If checkpoint review is enabled, `pi-spec-flow` automatically starts a fresh review session after a checkpoint handoff is saved.

That review session is intentionally separate from the implementation session. The reviewer sees the repository, the completed plan items, and the checkpoint handoff — not the implementation chat history. This makes the review behave more like an independent third-party code review.

After review, the flow stops. You decide what to do next.

## Configuration

Create `spec-flow.config.json` in your project root:

```json
{
  "$schema": "./spec-flow.schema.json",
  "ticketsFolder": "./docs/features",
  "checkpointReview": {
    "enabled": true,
    "model": "openai-codex/gpt-5.5",
    "thinkingLevel": "high",
    "skills": ["code-reviewer", "senior-security"]
  }
}
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `ticketsFolder` | `./docs/features` | Where generated plan files are stored |
| `checkpointReview.enabled` | `false` | Whether to run checkpoint reviews |
| `checkpointReview.model` | current model | Model used for checkpoint review |
| `checkpointReview.thinkingLevel` | `medium` | Thinking level used for checkpoint review |
| `checkpointReview.skills` | `[]` | Review skills to apply |

Use `provider/model` for `checkpointReview.model` when you want precise model selection.

## Commands

| Command | Description |
|---------|-------------|
| `/spec-flow-init <spec.md> [--feature <key>]` | Create an implementation plan from a spec |
| `/spec-flow-implement [--feature <key>]` | Start or continue implementation until the next checkpoint |
| `/spec-flow-start [--feature <key>]` | Alias for `/spec-flow-implement` |
| `/spec-flow-next` | Open the next planned item in the current session |
| `/spec-flow-next --new` | Open the next planned item in a fresh session |
| `/spec-flow-next <id> --new` | Open a specific item in a fresh session |
| `/spec-flow-next --feature=<key>` | Scope selection to a feature |

## Where files are stored

Generated plan files are stored under:

```text
{ticketsFolder}/{feature-key}/
```

Default:

```text
./docs/features
```

Because the plan lives in your repo, it can be reviewed, versioned, shared, and resumed across sessions.

## Recommended usage

Use `pi-spec-flow` for work that benefits from planning and checkpoints:

- new product features
- multi-file refactors
- migrations
- API or data model changes
- security-sensitive changes
- work that needs a second-pass review
- anything likely to exceed one clean chat context

For tiny fixes, a normal Pi session may be faster.

## Changelog

This changelog tracks **breaking changes only**. Do not update this section for additive features, bug fixes, documentation edits, or internal refactors that preserve the existing command workflow.

### Breaking changes

- None recorded.
