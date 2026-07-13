import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import { initTicketsStore, insertFullTicket, listTicketsForSpec } from "../src/tickets-fs.js";
import { savePlanningContext } from "../src/planning-context.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("planning context", () => {
  it("resolves a spec-local ticket store after its spec path changes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spec-flow-context-"));
    fixtures.push(cwd);
    await writeFile(
      join(cwd, "spec-flow.config.json"),
      JSON.stringify({ ticketsFolder: "./tickets", ticketsFolderBase: "spec" }),
    );
    await mkdir(join(cwd, "features", "doing", "moved-feature", "tickets"), { recursive: true });

    initTicketsStore(cwd, {
      sourceSpecPath: "features/doing/moved-feature/spec.md",
      ticketsFolder: "./tickets",
      ticketsFolderBase: "spec",
    });
    insertFullTicket({
      title: "Moved ticket",
      description: "A ticket whose spec directory moved.",
      source_section: "## Test",
      feature_key: "moved-feature",
      source_spec_path: "features/ready/moved-feature/spec.md",
    });

    savePlanningContext(cwd, "moved-feature", "features/doing/moved-feature/spec.md", {
      ticketsFolder: "./tickets",
      ticketsFolderBase: "spec",
    });
    initTicketsStore(cwd, "features/doing/moved-feature/spec.md");

    assert.equal(listTicketsForSpec("moved-feature").length, 1);
  });
});
