import { existsSync, readdirSync, rmSync } from "node:fs";
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
 * Target directories where Opper skills land. The upstream `skills` tool
 * keeps the canonical files at `~/.agents/skills/` and symlinks them into
 * each agent's expected path (`~/.claude/skills/`, `~/.codex/skills/`,
 * etc.). We surface all three so users can tell at a glance whether their
 * preferred agents see the skills.
 */
function agentsSkillsDir(): string {
  return (
    process.env.OPPER_SKILLS_HOME ??
    join(homedir(), ".agents", "skills")
  );
}

function claudeSkillsDir(): string {
  return join(homedir(), ".claude", "skills");
}

function codexSkillsDir(): string {
  return join(homedir(), ".codex", "skills");
}

export type SkillTargetName = "agents" | "claude" | "codex";

interface SkillTarget {
  name: SkillTargetName;
  dir(): string;
  isLive(): boolean;
}

const TARGETS: SkillTarget[] = [
  { name: "agents", dir: agentsSkillsDir, isLive: () => true },
  { name: "claude", dir: claudeSkillsDir, isLive: () => true },
  {
    name: "codex",
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
  // Inherit stdio so the upstream tool can drive its own interactive
  // prompt (skill picker, install location, etc.). The user is in the
  // best position to choose; we don't auto-pick anything.
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

/**
 * Remove every existing opper-* skill folder across all live targets.
 * Required to recover from the legacy bundled-copy install path: those
 * directories were dropped by older versions of this CLI and the upstream
 * `skills` tool doesn't know about them, so its `remove` command is a
 * no-op on legacy installs.
 */
function purgeOpperSkillDirs(): void {
  for (const t of liveTargets()) {
    for (const skill of listOpperSkillsIn(t)) {
      try {
        rmSync(join(t.dir(), skill), { recursive: true, force: true });
      } catch {
        // Best-effort: swallow filesystem errors and let the upstream
        // tool make its attempt next.
      }
    }
  }
}

export async function installSkills(): Promise<SkillsResult> {
  // Wipe any leftovers (legacy bundled-copy installs, half-removed sets)
  // so `npx skills add` writes into a clean slate.
  purgeOpperSkillDirs();
  runSkillsTool(["add", SKILLS_SOURCE]);
  return { source: SKILLS_SOURCE };
}

export async function updateSkills(): Promise<SkillsResult> {
  // The upstream `skills` tool's update path is `add` — it overwrites in
  // place when a source is already registered. Purge first so legacy
  // dirs get refreshed even if upstream's add is a no-op.
  purgeOpperSkillDirs();
  runSkillsTool(["add", SKILLS_SOURCE]);
  return { source: SKILLS_SOURCE };
}

export async function uninstallSkills(): Promise<SkillsResult> {
  // Try the upstream remove first so registered installs unregister
  // cleanly, then nuke any opper-* dirs that are still on disk
  // (legacy bundle leftovers).
  try {
    runSkillsTool(["remove", SKILLS_SOURCE]);
  } catch {
    // Fall through to the on-disk purge — even if upstream complains
    // (e.g. nothing registered for this source), we still want the
    // leftover dirs gone.
  }
  purgeOpperSkillDirs();
  return { source: SKILLS_SOURCE };
}
