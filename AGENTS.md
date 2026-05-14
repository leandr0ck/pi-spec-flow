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

1. **Always read Pi extension docs first** before changing architecture, APIs, events, tools, or resources.
   - Main: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
   - Examples: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/`

2. Keep modular boundaries (inside `src/`):
   - `commands.ts` only commands
   - `tools.ts` only tool registrations
   - `events.ts` only event handlers
   - pure helpers in `formatters.ts`, `spec-parser.ts`, `methodology-loader.ts`

3. Runtime skills used by the published extension must live under:
   - `skills/`

   Dev-only workflow skills must live under:
   - `.agents/skills/`

4. If adding new runtime resources (skills/prompts/themes), register through `resources_discover` in `src/events.ts`.

5.
6. Preserve backward-safe UX commands:
   - `/spec-flow-init`
   - `/spec-flow-list`
   - `/spec-flow-next`
