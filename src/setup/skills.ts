import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { OpperError } from "../errors.js";

/**
 * Source repo for the upstream `skills` tool to consume.
 * `npx skills add opper-ai/opper-skills` clones / installs from here.
 */
const SKILLS_SOURCE = "opper-ai/opper-skills";

/**
 * Target directories where Opper skills land. These are the conventions
 * the upstream `skills` tool follows, and what we scan for `opper ask`
 * grounding and the `opper skills list` matrix.
 */
function claudeSkillsDir(): string {
  return (
    process.env.OPPER_SKILLS_HOME ??
    join(homedir(), ".claude", "skills")
  );
}

function codexSkillsDir(): string {
  return (
    process.env.OPPER_CODEX_SKILLS_HOME ??
    join(homedir(), ".codex", "skills")
  );
}

export type SkillTargetName = "claude" | "codex";

interface SkillTarget {
  name: SkillTargetName;
  dir(): string;
  isLive(): boolean;
}

const TARGETS: SkillTarget[] = [
  { name: "claude", dir: claudeSkillsDir, isLive: () => true },
  {
    name: "codex",
    // Only consider Codex "live" if the user has the directory tree —
    // upstream `skills` may or may not place files there depending on
    // its current capabilities.
    dir: codexSkillsDir,
    isLive: () => existsSync(join(homedir(), ".codex")),
  },
];

function liveTargets(): SkillTarget[] {
  return TARGETS.filter((t) => t.isLive());
}

/** A single Opper skill folder: any `opper-*` directory with a SKILL.md. */
function isOpperSkillDir(target: string, entry: string): boolean {
  if (!entry.startsWith("opper-")) return false;
  return existsSync(join(target, entry, "SKILL.md"));
}

function listOpperSkillsIn(target: SkillTarget): string[] {
  const dir = target.dir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((entry) => isOpperSkillDir(dir, entry))
      .sort();
  } catch {
    return [];
  }
}

export function isSkillsInstalled(): boolean {
  return liveTargets().some((t) => listOpperSkillsIn(t).length > 0);
}

export interface TargetStatus {
  target: SkillTargetName;
  dir: string;
  installed: string[];
}

export function installedTargets(): TargetStatus[] {
  return liveTargets().map((t) => ({
    target: t.name,
    dir: t.dir(),
    installed: listOpperSkillsIn(t),
  }));
}

export async function listInstalledSkills(): Promise<string[]> {
  const seen = new Set<string>();
  for (const t of liveTargets()) {
    for (const name of listOpperSkillsIn(t)) seen.add(name);
  }
  return [...seen].sort();
}

/**
 * Run the upstream `skills` tool. We don't bundle skill content ourselves
 * any more — the canonical source is the github.com/opper-ai/opper-skills
 * repo, installed via `npx skills`.
 */
function runSkillsTool(args: string[]): void {
  const result = spawnSync("npx", ["-y", "skills", ...args], {
    stdio: "inherit",
  });
  if (result.error) {
    throw new OpperError(
      "API_ERROR",
      `Failed to run \`npx skills ${args.join(" ")}\``,
      result.error.message,
    );
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new OpperError(
      "API_ERROR",
      `\`npx skills ${args.join(" ")}\` exited with code ${result.status}`,
      "Make sure you have a recent npx and a working network connection.",
    );
  }
}

export interface SkillsResult {
  source: string;
}

export async function installSkills(): Promise<SkillsResult> {
  runSkillsTool(["add", SKILLS_SOURCE]);
  return { source: SKILLS_SOURCE };
}

export async function updateSkills(): Promise<SkillsResult> {
  // The upstream `skills` tool's update path is `add` — it overwrites in
  // place when a source is already registered.
  runSkillsTool(["add", SKILLS_SOURCE]);
  return { source: SKILLS_SOURCE };
}

export async function uninstallSkills(): Promise<SkillsResult> {
  runSkillsTool(["remove", SKILLS_SOURCE]);
  return { source: SKILLS_SOURCE };
}
