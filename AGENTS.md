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
│   ├── tickets-fs.ts
│   ├── formatters.ts
│   ├── spec-parser.ts
│   └── methodology-loader.ts
├── skills/
│   └── planning-methodology/
│       └── SKILL.md
└── .agents/skills/
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


1. **Always read Pi extension docs first** before changing architecture, APIs, events, tools, or resources.

2. Keep modular boundaries (inside `src/`):
   - `commands.ts` only commands
   - `tools.ts` only tool registrations
   - `events.ts` only event handlers
   - pure helpers in `formatters.ts`, `spec-parser.ts`, `methodology-loader.ts`

3. Runtime skills used by the published extension must live under:
   - `skills/`

   Dev-only workflow skills must live under:
   - `.pi/skills/`

4. If adding new runtime resources (skills/prompts/themes), register through `resources_discover` in `src/events.ts`.

5. Preserve backward-safe UX commands:
   - `/spec-flow-init`
   - `/spec-flow-next`

always use English Language 
