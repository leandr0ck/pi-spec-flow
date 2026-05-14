/**
 * Spec file parser — reads a Markdown spec and extracts sections.
 */
export interface SpecSection {
  title: string;
  content: string;
}

/**
 * Parse a Markdown spec into an overview and sections (delimited by `## `).
 */
export function parseSpecSections(content: string): {
  overview: string;
  sections: SpecSection[];
} {
  const parts = content.split(/^## /m);
  const overview = parts[0].trim();
  const sections: SpecSection[] = [];

  for (let i = 1; i < parts.length; i++) {
    const section = parts[i];
    const firstNewline = section.indexOf("\n");
    const title =
      firstNewline > 0 ? section.slice(0, firstNewline).trim() : section.trim();
    const body =
      firstNewline > 0 ? section.slice(firstNewline + 1).trim() : "";

    if (!title) continue;
    sections.push({ title, content: body });
  }

  return { overview, sections };
}

/**
 * Build a compact summary of a spec file for LLM consumption.
 * Truncates long sections to keep context manageable.
 */
export function buildSpecSummary(content: string, specFile: string): string {
  const { overview, sections } = parseSpecSections(content);

  const lines: string[] = [];
  lines.push(`**Spec File:** \`${specFile}\``);
  lines.push("");

  if (overview) {
    lines.push("## Overview");
    lines.push(overview);
    lines.push("");
  }

  lines.push("## Sections");
  for (const s of sections) {
    lines.push(`### ${s.title}`);
    const body =
      s.content.length > 500 ? s.content.slice(0, 500) + "..." : s.content;
    lines.push(body);
    lines.push("");
  }

  return lines.join("\n");
}
