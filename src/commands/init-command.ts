/**
 * /spec-flow-init command — reads a spec and guides the LLM to create structured tickets.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolve, basename } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import {
  initTicketsStore,
  ticketCountForSpec,
  clearTicketsForSpec,
} from "../tickets-fs.js";
import { parseSpecSections, buildSpecSummary } from "../spec-parser.js";
import { loadMethodology } from "../methodology-loader.js";
import { savePlanningContext } from "../planning-context.js";
import {
  normalizeFeatureName,
  suggestFeatureNameFromSpec,
  parseSpecFlowInitArgs,
  toStoredSpecPath,
} from "./command-helpers.js";

export function registerInitCommand(pi: ExtensionAPI): void {
  pi.registerCommand("spec-flow-init", {
    description:
      "Read a spec and guide LLM to create structured tickets following planning methodology",
    getArgumentCompletions: (prefix: string) => {
      try {
        const files = readdirSync(process.cwd())
          .filter((f: string) => f.endsWith(".md"))
          .map((f: string) => ({
            value: f,
            label: f,
            description: "Markdown spec file",
          }));
        const filtered = prefix
          ? files.filter((f: { value: string }) => f.value.startsWith(prefix))
          : files;
        return filtered.length > 0 ? filtered : null;
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      const parsedInit = parseSpecFlowInitArgs(args);
      if (!parsedInit) {
        ctx.ui.notify("Usage: /spec-flow-init <path-to-spec.md> [--feature \"feature-name\"]", "error");
        return;
      }

      const normalizedArgs = parsedInit.specArg.trim().replace(/^@+/, "");
      const specPath = resolve(ctx.cwd, normalizedArgs);
      let content: string;
      try {
        ctx.ui.notify("Reading spec internally...", "info");
        content = readFileSync(specPath, "utf-8");
      } catch {
        ctx.ui.notify(`Cannot read file: ${specPath}`, "error");
        return;
      }

      const specFile = basename(specPath);
      let featureName = parsedInit.featureName
        ? normalizeFeatureName(parsedInit.featureName)
        : suggestFeatureNameFromSpec(content, specFile);

      if (!parsedInit.featureName) {
        const confirmed = await ctx.ui.confirm(
          "Confirm feature name",
          `No --feature flag provided. Suggested from spec title: "${featureName}". Use this name?`
        );

        if (!confirmed) {
          ctx.ui.notify(
            "Init cancelled. Re-run with --feature \"feature-name\".",
            "info"
          );
          return;
        }
      }
      const { sections } = parseSpecSections(content);
      const storedSpecPath = toStoredSpecPath(ctx.cwd, specPath);

      if (sections.length === 0) {
        ctx.ui.notify(
          "No '##' sections found in spec. Nothing to ticket-ify.",
          "warning"
        );
        return;
      }

      // Init tickets store
      initTicketsStore(ctx.cwd);
      savePlanningContext(ctx.cwd, featureName, storedSpecPath);

      // Clear existing tickets if user confirms
      const existingCount = ticketCountForSpec(featureName);
      if (existingCount > 0) {
        const replace = await ctx.ui.confirm(
          "Tickets exist",
          `${existingCount} ticket(s) already exist for feature "${featureName}". Replace them?`
        );
        if (!replace) {
          ctx.ui.notify(
            "Init cancelled — existing tickets preserved.",
            "info"
          );
          return;
        }
        clearTicketsForSpec(featureName);
      }

      // Send the spec + planning methodology to the LLM as hidden context.
      // This keeps the TUI compact while preserving the full planning input.
      ctx.ui.notify("Loading planning methodology internally...", "info");
      const summary = buildSpecSummary(content, specFile);
      const msg = [
        summary,
        "",
        "---",
        "",
        loadMethodology(),
        "",
        "**Your task — create and validate tickets one at a time:**",
        "",
        "1. Create ticket #1 using `spec_flow_create`. Start with Foundation phase.",
        "2. Stop after each `spec_flow_create`. The extension validates the created ticket automatically after the turn.",
        "3. If validation passes, the extension will tell you to create the next ticket. Repeat until all tickets are created.",
        "4. If validation fails, the extension will send a fix checklist. **Re-read the source spec document** if needed, then use `spec_flow_update` to fix only the failing fields. The extension will re-validate automatically.",
        "5. After ALL tickets pass individually, run `spec_flow_validate_tickets` for cross-cutting checks.",
        "",
        "Create Foundation phase tickets first, then Core Features, then Polish. Add checkpoint tickets every 2-3 tasks and at phase boundaries.",
        `Use feature_key: "${featureName}" for all tickets (this is the feature key/folder).`,
        `Use source_spec_path: "${storedSpecPath}" for all tickets (this is the real spec file path).`,
        `Spec source file loaded: "${specFile}".`,
        "",
        "Every ticket MUST have: acceptance_criteria, verification, estimated_scope (XS/S/M/L), phase, and source_spec_path.",
      ].join("\n");

      pi.sendMessage(
        {
          customType: "spec-flow-init",
          content: msg,
          display: false,
          details: { specFile, featureName, sections: sections.length },
        },
        { triggerTurn: true },
      );
      ctx.ui.notify(
        `Loaded spec "${specFile}" for feature "${featureName}" (${sections.length} sections). Creating tickets...`,
        "info"
      );
    },
  });
}
