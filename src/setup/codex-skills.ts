import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const SENTINEL_OPEN = "# >>> opper-cli-skills >>>";
const SENTINEL_CLOSE = "# <<< opper-cli-skills <<<";

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function codexSkillsDir(): string {
  return join(codexHome(), "skills");
}

export function codexConfigPath(): string {
  return join(codexHome(), "config.toml");
}

/**
 * Codex auto-discovers skill files but *also* requires a corresponding
 * `[[skills.config]]` block in config.toml to enable each one. We bracket
 * our entries with a managed sentinel block so the user's own skill
 * registrations are never touched.
 */
export async function registerCodexSkills(
  skillNames: readonly string[],
): Promise<void> {
  const cfg = codexConfigPath();
  let existing = "";
  if (existsSync(cfg)) existing = await readFile(cfg, "utf8");
  const cleaned = stripBlock(existing);

  const entries = skillNames.flatMap((name) => [
    "[[skills.config]]",
    `path = "${join(codexSkillsDir(), name, "SKILL.md")}"`,
    "enabled = true",
    "",
  ]);
  const block = [
    SENTINEL_OPEN,
    "# Managed by `opper skills`. Edits between these markers will be",
    "# overwritten the next time you run `opper skills install/update`.",
    "",
    ...entries,
    SENTINEL_CLOSE,
    "",
  ].join("\n");

  const padded =
    cleaned.length === 0
      ? block
      : cleaned.endsWith("\n")
        ? cleaned + block
        : `${cleaned}\n${block}`;

  await mkdir(dirname(cfg), { recursive: true });
  await writeFile(cfg, padded, "utf8");
}

export async function unregisterCodexSkills(): Promise<void> {
  const cfg = codexConfigPath();
  if (!existsSync(cfg)) return;
  const text = await readFile(cfg, "utf8");
  if (!text.includes(SENTINEL_OPEN)) return;
  await writeFile(cfg, stripBlock(text), "utf8");
}

function stripBlock(text: string): string {
  const start = text.indexOf(SENTINEL_OPEN);
  if (start === -1) return text;
  const end = text.indexOf(SENTINEL_CLOSE, start);
  if (end === -1) return text;
  const before = text.slice(0, start).replace(/\n$/, "");
  const after = text.slice(end + SENTINEL_CLOSE.length).replace(/^\n/, "");
  if (before.length === 0) return after;
  return `${before}\n${after}`;
}
