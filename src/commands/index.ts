/**
 * spec-flow commands barrel — re-exports registerCommands for the extension entry point.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerInitCommand } from "./init-command.js";
import { registerNextCommand } from "./next-command.js";
import { registerCheckpointReviewCommand } from "./checkpoint-review-command.js";

export function registerCommands(pi: ExtensionAPI): void {
  registerInitCommand(pi);
  registerNextCommand(pi);
  registerCheckpointReviewCommand(pi);
}
