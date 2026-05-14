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
 *   - Phased with checkpoints between phases
 *
 * Commands:
 *   /spec-flow-init <path>  — Read a spec and guide the LLM to create structured tickets
 *   /spec-flow-list         — List all tickets with phases and status
 *   /spec-flow-next         — Show next pending ticket with full context
 *
 * Tools (for LLM):
 *   spec_flow_query   — Query tickets by status or ID
 *   spec_flow_create  — Create a ticket with full planning fields
 *   spec_flow_update  — Update ticket status
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.js";
import { registerTools } from "./tools.js";
import { registerEvents } from "./events.js";

export default function (pi: ExtensionAPI) {
  registerCommands(pi);
  registerTools(pi);
  registerEvents(pi);
}
