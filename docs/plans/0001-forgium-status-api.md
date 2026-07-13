# Implementation Plan: Forgium Status API

**Status:** Proposed  
**Date:** 2026-07-12  
**Repository:** `pi-spec-flow`  
**Consumers:** Forgium's `PiSpecFlowExecutionAdapter`

## Goal

Expose a deterministic, read-only status contract for a spec-flow ticket set
so external orchestrators can inspect progress without reimplementing ticket
filesystem parsing or interpreting human-formatted Pi output.

## Non-goals

- Moving ticket ownership or lifecycle rules into Forgium.
- Replacing `/spec-flow-init`, `/spec-flow-implement`, or `/spec-flow-next`.
- Starting an LLM turn from the status API.
- Changing the ticket Markdown format or checkpoint workflow.

## Proposed public contract

Add a pure/read-only function and a Pi tool with the same result shape:

```ts
export interface SpecFlowStatus {
  sourceSpecPath: string | null;
  featureKey: string | null;
  ticketsFolder: string;
  total: number;
  pending: number;
  inProgress: number;
  done: number;
  checkpoints: {
    total: number;
    completed: number;
    pendingReview: number;
  };
  nextTicket?: {
    id: number;
    title: string;
    featureKey: string;
    status: "pending" | "in_progress";
    isCheckpoint: boolean;
  };
  complete: boolean;
  issues: string[];
}
```

The result must be derived from the existing `tickets-fs.ts`, planning context,
checkpoint and handoff helpers. The implementation must not mutate the ticket
store, create folders, mark tickets in progress, or open a session.

## Proposed entry points

1. `inspectSpecFlowStatus(cwd, options?)` exported from a focused module for
   programmatic consumers.
2. `spec_flow_status` Pi tool returning the same object for extension/agent
   usage.

The optional selector should accept `specPath` and/or `featureKey`. Ambiguous
selectors must return an issue instead of choosing a feature implicitly.

## Contract decisions to confirm during implementation

- Whether `pendingReview` means only a checkpoint with a saved handoff awaiting
  review, or includes any checkpoint ticket not yet closed.
- Whether a missing `spec-flow.config.json` is reported as an issue or uses the
  existing default folder silently.
- Whether `complete` requires all tickets `done` and no pending checkpoint
  review, or only all tickets `done`.
- Exact tool parameter names and error representation used by current Pi
  extension conventions.

## Implementation sequence

### 1. Baseline and fixtures

- Add read-only fixtures for spec-local and legacy/global ticket folders.
- Add fixtures for pending, in-progress, done, checkpoint and missing handoff
  states.
- Confirm existing tests and typecheck pass before editing.

### 2. Pure status inspector

- Extract only the necessary read-only helpers into a focused module.
- Resolve config and planning context through existing APIs.
- Compute deterministic counts, next ticket ordering and checkpoint state.
- Return structured issues for missing/ambiguous selectors and malformed data.

### 3. Pi tool wrapper

- Register `spec_flow_status` in `src/tools.ts`.
- Validate parameters with the existing TypeBox conventions.
- Return the pure inspector result without invoking an LLM or mutating state.
- Add compact tool rendering if required by current tool UX.

### 4. Consumer contract test

- Add a fixture test that serializes the result as JSON and verifies stable
  fields and statuses.
- Document the contract for Forgium's adapter.
- Only then implement the corresponding adapter in the Forgium repository.

## Acceptance criteria

- [ ] Status can be queried by spec path and by feature key.
- [ ] Spec-local and legacy/global ticket folders resolve correctly.
- [ ] Counts and next-ticket ordering match `listTicketsForSpec` semantics.
- [ ] Checkpoint and handoff state is reported without changing files.
- [ ] Ambiguous or missing selectors return structured issues.
- [ ] `spec_flow_status` returns the same shape as the pure API.
- [ ] No LLM call, session change, ticket mutation, or folder creation occurs.
- [ ] Existing commands and ticket file format remain backward compatible.

## Verification

```bash
npm run typecheck
```

Additionally run the repository's fixture/unit tests and manually invoke the
tool through Pi RPC if the local Pi installation is available.

