/**
 * spec-flow — Pi extension that creates actionable tickets from a Technical Specification.
 *
 * Tickets are stored as Markdown files with YAML frontmatter.
 * Folder structure:
 *   {ticketsFolder}/{feature-name}/001-ticket-slug.md
 * Default ticketsFolder: ./docs/features (configurable via spec-flow.config.json)
 * Follows the planning-and-task-breakdown methodology:
 *   - Vertical slicing: each ticket is a complete feature path
 *   - Dependency graph analysis
 *   - Acceptance criteria, verification steps, scope estimation
 *   - Phased with checkpoints every 2-3 tasks and at phase boundaries
 *
 * Commands:
 *   /spec-flow-init <path>  — Read a spec and guide the LLM to create structured tickets
 *   /spec-flow-next         — Show next pending ticket (supports --new and --feature)
 *   /spec-flow-implement    — Start implementation flow block-by-block until each checkpoint
 *   /spec-flow-start         — Alias of /spec-flow-implement
 *
 * Tools (for LLM):
 *   spec_flow_create  — Create a ticket with full planning fields
 *   spec_flow_update  — Update ticket status (supports auto_next chaining)
 *   spec_flow_handoff_loop_done — Validate handoff and close ticket safely
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.js";
import { registerTools } from "./tools.js";
import { registerEvents } from "./events.js";
import { registerCompactBuiltinToolRenderers } from "./builtin-tool-renderers.js";

export default function (pi: ExtensionAPI) {
  registerCompactBuiltinToolRenderers(pi);
  registerCommands(pi);
  registerTools(pi);
  registerEvents(pi);
}
