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

Recommended setup: keep each spec and its tickets together.

Create `spec-flow.config.json` in your project root:

```json
{
  "ticketsFolder": "./tickets",
  "ticketsFolderBase": "spec"
}
```

Then use the spec path as the main handle for the whole workflow:

```text
1. Write a spec:  docs/my-feature-spec.md
2. Plan work:     /spec-flow-init docs/my-feature-spec.md
3. Implement:     /spec-flow-implement docs/my-feature-spec.md
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
/spec-flow-init <spec.md>
```

Example:

```text
/spec-flow-init docs/checkout-spec.md
```

Pi will read the spec and create a structured implementation plan stored in your repo as Markdown.

With the recommended config, tickets are written beside the spec:

```text
docs/tickets/
```

No feature folder is required. The spec path scopes where the tickets live.

The extension validates the plan as it is created so implementation starts from clear, testable work instead of a vague backlog.

### 3. Implement block by block

Run:

```text
/spec-flow-implement <spec.md>
```

Example:

```text
/spec-flow-implement docs/checkout-spec.md
```

The extension starts the next implementation block and keeps the session focused on the relevant work. At checkpoint boundaries, it saves a concise handoff so the next block does not need the full prior chat history.

The spec path tells spec-flow exactly which ticket folder to use. This is the preferred flow for end users.

`--feature` is still supported for older/global ticket-folder setups, but you usually do not need it when tickets live beside the spec.

### 4. Review checkpoints when configured

If checkpoint review is enabled, `pi-spec-flow` automatically starts a fresh review session after a checkpoint handoff is saved.

That review session is intentionally separate from the implementation session. The reviewer sees the repository, the completed plan items, and the checkpoint handoff — not the implementation chat history. This makes the review behave more like an independent third-party code review.

After review, the flow stops. You decide what to do next.

### 5. Inspect progress programmatically

External orchestrators can use the read-only `spec_flow_status` tool, or the
exported `inspectSpecFlowStatus(cwd, { featureKey, specPath })` API. It returns
stable JSON with ticket counts, the next ticket, checkpoint review blockers,
and a `complete` flag. It never creates a ticket store, changes ticket files,
opens a session, or invokes a model.

## Configuration

Recommended `spec-flow.config.json`:

```json
{
  "ticketsFolder": "./tickets",
  "ticketsFolderBase": "spec",
  "checkpointReview": {
    "enabled": false,
    "skills": []
  }
}
```

Full example with checkpoint review enabled:

```json
{
  "ticketsFolder": "./tickets",
  "ticketsFolderBase": "spec",
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
| `ticketsFolder` | `./docs/features` | Relative or absolute folder where generated plan files are stored. Recommended: `./tickets` |
| `ticketsFolderBase` | `cwd` | Base used to resolve relative `ticketsFolder` values: `spec` for the directory containing the spec, or `cwd` for the project root. Recommended: `spec` |
| `checkpointReview.enabled` | `false` | Whether to run checkpoint reviews |
| `checkpointReview.model` | current model | Model used for checkpoint review |
| `checkpointReview.thinkingLevel` | `medium` | Thinking level used for checkpoint review |
| `checkpointReview.skills` | `[]` | Review skills to apply |

Use `provider/model` for `checkpointReview.model` when you want precise model selection.

### Recommended: store tickets beside the spec file

With:

```json
{
  "ticketsFolder": "./tickets",
  "ticketsFolderBase": "spec"
}
```

this command:

```bash
/spec-flow-init docs/specs/payments.md
```

creates tickets under:

```text
docs/specs/tickets/
```

In `spec` mode, spec-flow does **not** create an extra `{feature-key}` subfolder. The spec file already scopes the ticket folder location, so ticket Markdown files are written directly into `tickets/`.

To implement that ticket set, pass the same spec path:

```bash
/spec-flow-implement docs/specs/payments.md
```

or for a single-ticket kickoff:

```bash
/spec-flow-next docs/specs/payments.md
```

When `ticketsFolderBase` is `spec`, `--feature` is optional without an interactive confirmation. If omitted, spec-flow derives the feature key from the spec title or filename.

You can also use command flags for one-off runs without changing `spec-flow.config.json`:

```bash
/spec-flow-init docs/specs/payments.md --tickets-next-to-spec
```

Equivalent explicit form:

```bash
/spec-flow-init docs/specs/payments.md --tickets-folder-base spec --tickets-folder ./tickets
```

### Legacy/global ticket folder mode

If you prefer one global ticket folder for the whole repository, use:

```json
{
  "ticketsFolder": "./docs/features",
  "ticketsFolderBase": "cwd"
}
```

In this mode, tickets are stored under:

```text
docs/features/{feature-key}/
```

and it is useful to pass a feature key:

```bash
/spec-flow-init docs/specs/payments.md --feature payments
/spec-flow-implement --feature payments
```

## Commands

| Command | Description |
|---------|-------------|
| `/spec-flow-init <spec.md>` | Create an implementation plan from a spec using the recommended spec-local ticket folder |
| `/spec-flow-implement <spec.md>` | Start or continue implementation for tickets stored next to that spec |
| `/spec-flow-next <spec.md>` | Open the next planned item for tickets stored next to that spec |
| `/spec-flow-init <spec.md> [--feature <key>]` | Create an implementation plan with an explicit feature key, mainly for legacy/global folder mode |
| `/spec-flow-init <spec.md> --tickets-next-to-spec` | Create tickets under `./tickets` beside the spec file, useful for one-off command-line/tool execution without editing config |
| `/spec-flow-init <spec.md> --tickets-folder-base spec --tickets-folder ./tickets` | Explicitly override ticket folder placement for this feature |
| `/spec-flow-implement [--feature <key>]` | Start or continue implementation. When `--feature` is provided, only tickets in that feature are validated and considered — tickets in other features are ignored. |
| `/spec-flow-start [--feature <key>]` | Alias for `/spec-flow-implement` |
| `/spec-flow-next` | Open the next planned item in the current session |
| `/spec-flow-next --new` | Open the next planned item in a fresh session |
| `/spec-flow-next <id> --new` | Open a specific item in a fresh session |
| `/spec-flow-next --feature=<key>` | Scope selection to a feature |

## Where files are stored

With the recommended config, generated plan files are stored under:

```text
{spec-directory}/tickets/
```

Example:

```text
docs/specs/payments.md
docs/specs/tickets/001-first-ticket.md
docs/specs/tickets/002-second-ticket.md
```

In legacy/global folder mode, generated plan files are stored under:

```text
{ticketsFolder}/{feature-key}/
```

Built-in fallback default if no config is present:

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
