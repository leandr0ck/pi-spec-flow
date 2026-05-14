/**
 * Loads the planning-methodology skill content from its SKILL.md file.
 * This keeps the prompt template as a proper skill file rather than a hardcoded string.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SKILL_PATH = resolve(
  __dirname,
  "..",
  "skills",
  "planning-methodology",
  "SKILL.md"
);

/**
 * Load the methodology content, stripping YAML frontmatter.
 */
export function loadMethodology(): string {
  const content = readFileSync(SKILL_PATH, "utf-8");
  return stripFrontmatter(content);
}

/**
 * Strip YAML frontmatter (delimited by `---`) and return the body.
 */
function stripFrontmatter(raw: string): string {
  const lines = raw.split("\n");
  if (lines.length < 2 || lines[0].trim() !== "---") return raw;

  let endFm = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endFm = i;
      break;
    }
  }

  if (endFm === -1) return raw;
  return lines.slice(endFm + 1).join("\n").trim();
}
