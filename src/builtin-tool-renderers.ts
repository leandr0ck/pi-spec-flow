/**
 * Compact built-in tool renderers for spec-flow.
 *
 * The read tool still returns the real file content to the LLM, but the TUI
 * renders a short status instead of dumping full specs, skills, and tickets.
 */
import type { ExtensionAPI, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const readToolCache = new Map<string, ReturnType<typeof createReadTool>>();

function getReadTool(cwd: string): ReturnType<typeof createReadTool> {
  let tool = readToolCache.get(cwd);
  if (!tool) {
    tool = createReadTool(cwd);
    readToolCache.set(cwd, tool);
  }
  return tool;
}

function classifyReadPath(path: string | undefined): string {
  const normalized = (path ?? "").replace(/\\/g, "/");
  const lower = normalized.toLowerCase();

  if (lower.endsWith("skill.md") || lower.includes("/skills/")) return "skill";
  if (lower.includes("/docs/features/") || /(^|\/)\d{3}-[^/]+\.md$/.test(lower)) return "ticket";
  if (lower.includes("spec") && lower.endsWith(".md")) return "spec";
  if (lower.endsWith(".md")) return "document";
  return "file";
}

function lineCountFromResult(result: { content: Array<{ type: string; text?: string }> }): number | null {
  const text = result.content.find((entry) => entry.type === "text")?.text;
  return typeof text === "string" ? text.split("\n").length : null;
}

export function registerCompactBuiltinToolRenderers(pi: ExtensionAPI): void {
  const initialReadTool = getReadTool(process.cwd());

  pi.registerTool({
    ...initialReadTool,
    name: "read",
    label: "read",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getReadTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, _context) {
      const kind = classifyReadPath(args.path);
      const path = args.path ? theme.fg("accent", args.path) : theme.fg("muted", "...");
      const range = args.offset || args.limit
        ? theme.fg(
            "dim",
            ` (${args.offset ? `offset=${args.offset}` : ""}${args.offset && args.limit ? ", " : ""}${args.limit ? `limit=${args.limit}` : ""})`,
          )
        : "";

      return new Text(
        `${theme.fg("toolTitle", theme.bold("read"))} ${path} ${theme.fg("dim", `(${kind})`)}${range}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const kind = classifyReadPath(context.args.path);
      if (isPartial) {
        return new Text(theme.fg("warning", `Reading ${kind} internally...`), 0, 0);
      }

      const content = result.content.find((entry) => entry.type === "text");
      if (!content || content.type !== "text") {
        return new Text(theme.fg("success", `Loaded ${kind} internally`), 0, 0);
      }

      const details = result.details as ReadToolDetails | undefined;
      const lineCount = lineCountFromResult(result) ?? 0;
      let text = theme.fg("success", `Loaded ${kind} internally`);
      text += theme.fg("dim", ` (${lineCount} lines)`);

      if (details?.truncation?.truncated) {
        text += theme.fg("warning", ` — truncated from ${details.truncation.totalLines} lines`);
      }

      if (expanded) {
        const previewLines = content.text.split("\n").slice(0, 12);
        text += theme.fg("muted", "\nPreview only; full content was passed to the agent internally.");
        for (const line of previewLines) {
          text += `\n${theme.fg("dim", line)}`;
        }
        if (lineCount > previewLines.length) {
          text += `\n${theme.fg("muted", `... ${lineCount - previewLines.length} more lines hidden in UI`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
