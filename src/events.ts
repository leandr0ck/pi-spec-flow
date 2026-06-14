/**
 * spec-flow events — session_start status indicator + resources_discover
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  initTicketsStore,
  ticketsExist,
  listTickets,
} from "./tickets-fs.js";
import { loadLoopState } from "./ticket-loop.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLANNING_SKILL_PATH = resolve(
  __dirname,
  "..",
  "skills",
  "planning-methodology",
  "SKILL.md"
);
const IMPLEMENTATION_PROTOCOL_SKILL_PATH = resolve(
  __dirname,
  "..",
  "skills",
  "spec-flow-implementation-protocol",
  "SKILL.md"
);

// ── Event registration ──────────────────────────────────────

export function registerEvents(pi: ExtensionAPI): void {
  // Register only runtime skill resources (publishable)
  pi.on("resources_discover", async (_event, _ctx) => {
    return {
      skillPaths: [PLANNING_SKILL_PATH, IMPLEMENTATION_PROTOCOL_SKILL_PATH],
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    initTicketsStore(ctx.cwd);
    if (ticketsExist()) {
      const pending = listTickets("pending").length;
      const inProgress = listTickets("in_progress").length;
      const done = listTickets("done").length;
      const total = pending + inProgress + done;
      if (total > 0) {
        ctx.ui.setStatus(
          "spec-flow",
          `Tickets: ${done}/${total} done${
            inProgress > 0 ? `, ${inProgress} in progress` : ""
          }`
        );
      }
    }

    // Show active ticket loop status
    const loop = loadLoopState(ctx.cwd);
    if (loop && loop.status === "active") {
      ctx.ui.setStatus(
        "spec-flow-loop",
        `🔁 Ticket loop: ${loop.iteration}/${loop.maxIterations}`
      );
    }
  });
}
