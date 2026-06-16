## Project Structure

```text
.
├── AGENTS.md
├── package.json
├── spec-flow.config.json
├── spec.md
├── src/
│   ├── index.ts
│   ├── commands.ts
│   ├── tools.ts
│   ├── events.ts
│   ├── checkpoint-review-subagent.ts
│   ├── implementation-flow-runner.ts
│   ├── ticket-validation-runner.ts
│   ├── checkpoint-handoffs.ts
│   ├── checkpoints.ts
│   ├── tickets-fs.ts
│   ├── formatters.ts
│   ├── planning-context.ts
│   ├── prompt-builders.ts
│   ├── spec-parser.ts
│   ├── ticket-loop.ts
│   └── methodology-loader.ts
├── skills/
│   └── planning-methodology/
│       └── SKILL.md
└── .pi/skills/
    └── spec-flow-extension-development/
        └── SKILL.md
```

## Development Rules (Spec Flow Extension)

## Project Philosophy

1. **More planning, less implementation**
   - Invest in ticket quality, acceptance criteria, verification, and sequencing before coding.
   - Better planning reduces rework, saves tokens, and improves output quality.

2. **Avoid context rot to improve quality**
   - Prefer isolated, ticket-by-ticket execution with explicit handoffs.
   - Persist decisions in tickets/spec docs; do not rely on long chat memory.

3. **Token efficiency and pragmatic execution**
   - Minimize output verbosity and avoid unnecessary tool calls.
   - Be concise, action-oriented, and optimize for signal over noise.

4. **Runtime guarantees over prompt obedience**
   - Do not rely on the LLM to remember mandatory workflow steps.
   - If a step must always happen, implement it in extension runtime code using events, commands, or an explicit state machine.
   - Use prompts for cognitive work only: writing handoffs, reviewing code, summarizing findings.

5. **LLM produces content; extension orchestrates workflow**
   - Avoid making the LLM responsible for sequencing, global state restoration, model switching, or continuation logic.
   - Prefer deterministic extension-side orchestration for multi-turn workflows.


1. **Always read Pi extension docs first** before changing architecture, APIs, events, tools, or resources.

2. Keep modular boundaries (inside `src/`):
   - `commands.ts` only commands
   - `tools.ts` only tool registrations and atomic tool behavior
   - `events.ts` only event handlers
   - multi-turn command-owned chain runners or event/state-machine runners in focused helper modules when they grow beyond simple command glue
   - event compatibility/state-machine helpers may live in modules such as `implementation-flow-runner.ts`
   - pure helpers in `formatters.ts`, `spec-parser.ts`, `methodology-loader.ts`, `prompt-builders.ts`

3. Prefer command-owned chain runners for workflows that must switch models or sessions:
   - When a workflow must sequence multiple LLM turns, change model/thinking, or cross session boundaries, run it from an `ExtensionCommandContext` command handler.
   - Use the proven chain pattern: `pi.sendUserMessage(...)` → wait for turn start → `ctx.waitForIdle()` → inspect persisted ticket/handoff state → start the next step.
   - Do not enqueue slash commands from `agent_end` for mandatory chaining. That pattern was unreliable for implementation → checkpoint review chaining.
   - For checkpoint code review, the reviewer must run as a fresh third-party session: do not inherit implementation conversation context; pass only repository state, tickets, checkpoint handoff, configured review skills, model, and thinking level.

3a. Use event/state-machine runners only as compatibility or guard rails:
   - Persist state with `pi.appendEntry(...)` so it survives reloads/session history and follows branch semantics.
   - Drive simple local transitions from lifecycle events such as `agent_end` only when command-owned chaining is not needed.
   - Use simple explicit phases such as `armed`, `running`, `done`, and `error`.
   - If a command-owned chain is active, event runners must defer to the command runner and must not also start review or continuation work.

3b. Checkpoint review lifecycle is strict:
   - Implement block tickets.
   - Implement and close the checkpoint ticket.
   - Save the checkpoint handoff.
   - If `checkpointReview.enabled` is true and review skills are configured, run the review with the configured model and thinking level.
   - Prefer the command-owned chain path: after implementation reaches idle and the checkpoint handoff exists, open a fresh review session and wait for it to finish.
   - Show the review result in that fresh review session or in a dedicated review UI/report.
   - FIN. Stop there.
   - Do not inject the review result as an agent follow-up instruction.
   - Do not start the next ticket, do not call `/spec-flow-next`, do not modify files, and do not commit after review.

4. Keep custom tools atomic; avoid coordination tools when runtime can own the workflow:
   - Good custom tools: create/update tickets, validate handoffs, save checkpoint handoffs.
   - Avoid tools whose primary purpose is “call this next” or “restore this later” if the extension can guarantee it.
   - Commands may remain as manual entry points or fallbacks, but mandatory flow control belongs in runtime code.

5. Runtime skills used by the published extension must live under:
   - `skills/`

   Dev-only workflow skills must live under:
   - `.pi/skills/`

6. If adding new runtime resources (skills/prompts/themes), register through `resources_discover` in `src/events.ts`.

7. Preserve backward-safe UX commands:
   - `/spec-flow-init`
   - `/spec-flow-next`

Always use English language.
