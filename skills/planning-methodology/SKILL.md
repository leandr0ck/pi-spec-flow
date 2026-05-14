---
name: planning-methodology
description: >-
  Planning and task breakdown methodology for creating tickets from a technical
  specification. Used internally by the spec-flow extension's /spec-flow-init
  command to guide the LLM in creating structured, verifiable tickets.
user-invocable: false
auto-trigger: false
trigger_keywords: []
---

# Planning & Task Breakdown Methodology

Create **small, verifiable, dependency-ordered** tickets. The goal is reliable delivery, not large vague tasks.

## 0) Plan Mode First (No Coding)
Before creating tickets:
- Read the full spec and relevant code paths
- Identify existing conventions/patterns
- Map dependencies and risks
- Capture unknowns/open questions

Do **not** implement code during planning.

## 1) Analyze the Dependency Graph
Map what depends on what (foundation first). Typical chain:
Database schema → API models/types → API endpoints → frontend client/components → integration/deploy

Implementation order should follow dependency constraints.

## 2) Slice Vertically (not horizontally)
Prefer complete feature slices end-to-end.
- **Good:** “User can register” (schema + API + UI)
- **Bad:** “Build all DB”, then “Build all API”, then “Build all UI”

Each ticket should leave the system in a testable working state.

## 3) Assign Phases
- **Foundation**: prerequisites and shared infrastructure
- **Core Features**: main user-facing behavior
- **Polish**: UX refinements, hardening, docs, edge cases

## 4) Create Tickets with Full Structure
Use `spec_flow_create` for each task. Every ticket must include:
- `title`: short, specific action
- `description`: one paragraph with outcome and scope
- `acceptance_criteria`: specific, testable bullets
- `verification`: explicit checks (tests/build/manual)
- `dependencies`: task IDs or `None`
- `files_touched`: likely files/modules
- `estimated_scope`: `XS|S|M|L` only
- `phase`: `Foundation|Core Features|Polish`

## 5) Scope Discipline
Sizing:
- **XS**: 1 file
- **S**: 1–2 files
- **M**: 3–5 files
- **L**: 5–8 files
- **XL**: invalid for a single ticket → split further

Break down further if:
- >1 focused session of work
- acceptance criteria cannot be concise
- touches independent subsystems
- title contains “and” (often two tasks)

## 6) Add Checkpoint Tickets
After every 2–3 tasks, create `is_checkpoint: true` tickets verifying:
- tests pass
- build is clean
- critical flow works end-to-end
- ready to continue to next phase

## 7) Risk-First Ordering
Prioritize high-risk/uncertain tasks earlier (“fail fast”).
Include `risks` and `open_questions` in tickets when relevant.

## 8) Parallelization Rules
- **Parallel-safe:** independent slices, docs, tests for stable contracts
- **Sequential:** migrations, shared-state changes, strict dependency chains
- **Coordinate first:** shared API contracts before parallel implementation

## Red Flags (Reject/Rewrite)
- “Implement feature” without acceptance criteria
- Missing verification steps
- XL-sized tickets
- No checkpoints between phases
- Dependency order not explicit

## Final Plan Quality Gate
Before finishing `/spec-flow-init`, ensure:
- Every ticket has acceptance criteria and verification
- Dependencies are explicit and logically ordered
- No ticket exceeds L scope
- Checkpoints exist every 2–3 tasks
- Phases are balanced (Foundation → Core Features → Polish)
