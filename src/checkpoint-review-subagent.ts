import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCheckpointReviewConfig, listTicketsForSpec, type Ticket } from "./tickets-fs.js";
import { loadCheckpointHandoff } from "./checkpoint-handoffs.js";
import { appendDebugLog } from "./debug-log.js";
import { getBlockForTicket } from "./checkpoints.js";
import { formatTicketFull } from "./formatters.js";

type ReviewResult = {
  ok: boolean;
  reportPath: string;
  output: string;
  stderr: string;
  exitCode: number;
};

function safeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "review";
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function findSkillPath(skill: string, cwd: string): string | undefined {
  if (isAbsolute(skill)) return existsSync(skill) ? skill : undefined;

  const directCandidates = [
    join(cwd, ".pi", "skills", skill, "SKILL.md"),
    join(cwd, ".agents", "skills", skill, "SKILL.md"),
    join(homedir(), ".pi", "agent", "skills", skill, "SKILL.md"),
    join(homedir(), ".agents", "skills", skill, "SKILL.md"),
  ];
  for (const candidate of directCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  const roots = [
    join(cwd, ".pi", "skills"),
    join(cwd, ".agents", "skills"),
    join(homedir(), ".pi", "agent", "skills"),
    join(homedir(), ".agents", "skills"),
  ];

  const visit = (dir: string, depth: number): string | undefined => {
    if (depth < 0 || !existsSync(dir)) return undefined;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return undefined;
    }
    if (entries.includes(skill)) {
      const candidate = join(dir, skill, "SKILL.md");
      if (existsSync(candidate)) return candidate;
    }
    for (const entry of entries) {
      const found = visit(join(dir, entry), depth - 1);
      if (found) return found;
    }
    return undefined;
  };

  for (const root of roots) {
    const found = visit(root, 4);
    if (found) return found;
  }
  return undefined;
}

function loadSkillInstructions(skills: string[], cwd: string): string {
  return skills
    .map((skill) => {
      const skillPath = findSkillPath(skill, cwd);
      if (!skillPath) return `## Skill: ${skill}\n\nSkill file not found. Perform a strict code review anyway.`;
      return `## Skill: ${skill}\nPath: ${skillPath}\n\n${readFileSync(skillPath, "utf8").trim()}`;
    })
    .join("\n\n---\n\n");
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = process.execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

function finalAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .map((part: any) => part?.type === "text" ? part.text ?? "" : "")
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function buildSystemPrompt(skillInstructions: string): string {
  return [
    "You are a checkpoint code-review subagent running outside the main implementation conversation.",
    "Your job is to perform the configured review now, not to summarize the handoff.",
    "Use read-only inspection. Do not modify files.",
    "If you use bash, only run read-only commands such as git diff, git status, sed, rg, cat, npm test/typecheck when safe.",
    "Be concrete: cite files and line numbers where possible.",
    "",
    "Output format:",
    "## Review Summary",
    "## Critical Findings",
    "## Warnings",
    "## Suggestions",
    "## Verification Notes",
    "## Verdict",
    "## Final Note",
    "",
    "In Final Note, state that the review is complete. Do not tell the agent to continue, do not suggest starting another ticket, and do not include any /spec-flow-next command. The checkpoint review is the final action in this flow.",
    "",
    "Configured review skill instructions:",
    "",
    skillInstructions || "No skill instructions found; perform a strict code review anyway.",
  ].join("\n");
}

function reviewedTicketsContext(ticket: Ticket): string {
  const orderedTickets = listTicketsForSpec(ticket.feature_key);
  const block = getBlockForTicket(orderedTickets, ticket.id);
  const tickets = block?.tickets ?? [ticket];
  return tickets
    .map((reviewedTicket) => `## Ticket #${reviewedTicket.id}\n\n${formatTicketFull(reviewedTicket)}`)
    .join("\n\n---\n\n");
}

function buildTask(ticket: Ticket, cwd: string): string {
  const handoff = loadCheckpointHandoff(cwd, ticket.feature_key, ticket.id);
  return [
    `Review checkpoint #${ticket.id} for feature ${ticket.feature_key}.`,
    "",
    "Inspect the current repository state and the checkpoint handoff below.",
    "Focus on correctness, regressions, maintainability, security, whether verification is sufficient, and whether the code matches the tickets in the completed block.",
    "End after the review. Do not start the next ticket, do not modify files, do not commit, and do not include a next-ticket command.",
    "",
    "## Tickets to Consider",
    "",
    reviewedTicketsContext(ticket),
    "",
    "## Checkpoint Handoff",
    "",
    handoff?.content ?? "No checkpoint handoff content found.",
  ].join("\n");
}

async function writeTempPrompt(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spec-flow-review-"));
  const filePath = join(dir, "system-prompt.md");
  writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

export async function runCheckpointReviewSubagent(
  pi: ExtensionAPI,
  ctx: any,
  ticket: Ticket,
): Promise<ReviewResult> {
  const reviewConfig = getCheckpointReviewConfig();
  const skillInstructions = loadSkillInstructions(reviewConfig.skills, ctx.cwd);
  const systemPromptPath = await writeTempPrompt(buildSystemPrompt(skillInstructions));
  const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", systemPromptPath, "--tools", "read,grep,find,ls,bash"];
  if (reviewConfig.model) args.push("--model", reviewConfig.model);
  if (reviewConfig.thinkingLevel) args.push("--thinking", reviewConfig.thinkingLevel);
  args.push(buildTask(ticket, ctx.cwd));

  const startedAt = Date.now();
  appendDebugLog(ctx.cwd, "checkpoint-review-subagent", "start", {
    ticketId: ticket.id,
    featureKey: ticket.feature_key,
    model: reviewConfig.model,
    thinking: reviewConfig.thinkingLevel,
    skills: reviewConfig.skills,
    args: args.filter((arg) => arg !== systemPromptPath),
  });

  const messages: any[] = [];
  let stderr = "";
  let buffer = "";
  const invocation = getPiInvocation(args);

  const exitCode = await new Promise<number>((resolveExit) => {
    const proc = spawn(invocation.command, invocation.args, {
      cwd: ctx.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "message_end" && event.message) messages.push(event.message);
        if (event.type === "tool_result_end" && event.message) messages.push(event.message);
      } catch {
        // Ignore non-JSON output in JSON mode.
      }
    };

    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      resolveExit(code ?? 0);
    });

    proc.on("error", (error) => {
      stderr += error.message;
      resolveExit(1);
    });

    ctx.signal?.addEventListener?.("abort", () => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000);
    }, { once: true });
  });

  try {
    unlinkSync(systemPromptPath);
  } catch {
    // ignore cleanup errors
  }

  const output = finalAssistantText(messages) || stderr.trim() || "No review output captured.";
  const reviewDir = resolve(ctx.cwd, ".spec-flow", "checkpoint-reviews");
  ensureDir(reviewDir);
  const reportPath = resolve(
    reviewDir,
    `${safeFilePart(ticket.feature_key)}--checkpoint-${ticket.id}--${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
  );
  const report = [
    `# Checkpoint Review — ${ticket.feature_key} #${ticket.id}`,
    "",
    `- Created: ${new Date().toISOString()}`,
    `- Model: ${reviewConfig.model ?? "default"}`,
    `- Thinking: ${reviewConfig.thinkingLevel ?? "default"}`,
    `- Skills: ${reviewConfig.skills.join(", ") || "none"}`,
    `- Exit code: ${exitCode}`,
    "",
    output,
    stderr.trim() ? `\n\n## Subagent stderr\n\n\`\`\`\n${stderr.trim()}\n\`\`\`` : "",
  ].join("\n");
  writeFileSync(reportPath, report, "utf8");

  appendDebugLog(ctx.cwd, "checkpoint-review-subagent", "done", {
    ticketId: ticket.id,
    exitCode,
    durationMs: Date.now() - startedAt,
    outputLength: output.length,
    stderrLength: stderr.length,
    reportPath,
  });

  return { ok: exitCode === 0, reportPath, output, stderr, exitCode };
}
