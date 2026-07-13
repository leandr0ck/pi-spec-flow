import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import {
  initTicketsStore,
  insertFullTicket,
  updateTicket,
  updateTicketStatus,
} from "../src/tickets-fs.js";
import { inspectSpecFlowStatus } from "../src/status.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createFixture(options: { reviewEnabled?: boolean } = {}): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "spec-flow-status-"));
  fixtures.push(cwd);
  await writeFile(join(cwd, "spec.md"), "# Checkout\n", "utf8");
  await writeFile(
    join(cwd, "spec-flow.config.json"),
    JSON.stringify({
      ticketsFolder: "./tickets",
      ticketsFolderBase: "spec",
      checkpointReview: {
        enabled: options.reviewEnabled ?? false,
        skills: options.reviewEnabled ? ["code-review"] : [],
      },
    }),
    "utf8",
  );
  initTicketsStore(cwd, {
    sourceSpecPath: "spec.md",
    ticketsFolder: "./tickets",
    ticketsFolderBase: "spec",
  });
  return cwd;
}

function ticketInput(overrides: Partial<Parameters<typeof insertFullTicket>[0]> = {}) {
  return {
    title: "Implement checkout",
    description: "Implement the checkout flow.",
    source_section: "## Checkout",
    feature_key: "checkout",
    source_spec_path: "spec.md",
    acceptance_criteria: "- [ ] Checkout succeeds",
    verification: "- [ ] npm test",
    estimated_scope: "M",
    phase: "Core Features",
    ...overrides,
  };
}

describe("inspectSpecFlowStatus", () => {
  it("reports scoped counts and chooses in-progress before pending", async () => {
    const cwd = await createFixture();
    const first = insertFullTicket(ticketInput({ title: "Foundation", phase: "Foundation", order_index: 1 }));
    const second = insertFullTicket(ticketInput({ title: "Checkout UI", order_index: 2 }));
    updateTicketStatus(first.id, "done");
    updateTicketStatus(second.id, "in_progress");

    const status = inspectSpecFlowStatus(cwd, { featureKey: "checkout" });

    assert.equal(status.featureKey, "checkout");
    assert.equal(status.sourceSpecPath, "spec.md");
    assert.equal(status.ticketsFolder, join(cwd, "tickets"));
    assert.deepEqual(
      {
        total: status.total,
        pending: status.pending,
        inProgress: status.inProgress,
        done: status.done,
      },
      { total: 2, pending: 0, inProgress: 1, done: 1 },
    );
    assert.deepEqual(status.nextTicket, {
      id: second.id,
      title: "Checkout UI",
      featureKey: "checkout",
      status: "in_progress",
      isCheckpoint: false,
    });
    assert.equal(status.complete, false);
    assert.deepEqual(status.issues, []);
  });

  it("requires a selector when multiple features exist", async () => {
    const cwd = await createFixture();
    insertFullTicket(ticketInput({ feature_key: "checkout" }));
    insertFullTicket(ticketInput({ feature_key: "billing", title: "Billing" }));

    const status = inspectSpecFlowStatus(cwd);

    assert.equal(status.featureKey, null);
    assert.equal(status.total, 0);
    assert.match(status.issues[0] ?? "", /ambiguous/i);
    assert.match(status.issues[0] ?? "", /checkout/);
    assert.match(status.issues[0] ?? "", /billing/);
  });

  it("reports a saved checkpoint handoff awaiting configured review", async () => {
    const cwd = await createFixture({ reviewEnabled: true });
    const checkpoint = insertFullTicket(ticketInput({
      title: "Checkpoint",
      is_checkpoint: true,
      source_spec_path: "features/ready/checkout/spec.md",
      phase: "Foundation",
      order_index: 1,
    }));
    updateTicket(checkpoint.id, {
      status: "done",
      handoff_summary: "Implemented the foundation.",
      handoff_files: "src/checkout.ts",
      handoff_decisions: "Keep the workflow deterministic.",
      handoff_verification: "npm test passed",
      handoff_risks: "None",
      handoff_next_ticket: "None",
    });
    await mkdir(join(cwd, ".spec-flow", "checkpoint-handoffs"), { recursive: true });
    await writeFile(
      join(cwd, ".spec-flow", "checkpoint-handoffs", "checkout--checkpoint-" + checkpoint.id + ".json"),
      JSON.stringify({ featureKey: "checkout", checkpointTicketId: checkpoint.id }),
      "utf8",
    );

    const status = inspectSpecFlowStatus(cwd, { featureKey: "checkout" });

    assert.equal(status.checkpoints.total, 1);
    assert.equal(status.checkpoints.completed, 1);
    assert.equal(status.checkpoints.pendingReview, 1);
    assert.equal(status.complete, false);

    await mkdir(join(cwd, ".spec-flow", "checkpoint-reviews"), { recursive: true });
    await writeFile(
      join(
        cwd,
        ".spec-flow",
        "checkpoint-reviews",
        `checkout--checkpoint-${checkpoint.id}--review.md`,
      ),
      "# Review complete\n",
      "utf8",
    );

    const reviewedStatus = inspectSpecFlowStatus(cwd, { specPath: "spec.md" });
    assert.equal(reviewedStatus.checkpoints.pendingReview, 0);
    assert.equal(reviewedStatus.complete, true);
  });

  it("does not create or modify files when the store is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spec-flow-status-empty-"));
    fixtures.push(cwd);
    const before = await readFile(join(cwd, "missing.txt"), "utf8").catch(() => null);

    const status = inspectSpecFlowStatus(cwd, { featureKey: "checkout" });

    assert.equal(status.total, 0);
    assert.ok(status.issues.some((issue) => /no tickets store/i.test(issue)));
    assert.equal(await readFile(join(cwd, "missing.txt"), "utf8").catch(() => null), before);
  });
});
