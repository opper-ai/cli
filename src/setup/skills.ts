import { cp, mkdir, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OpperError } from "../errors.js";
import {
  codexHome,
  codexSkillsDir,
  registerCodexSkills,
  unregisterCodexSkills,
} from "./codex-skills.js";

// Skills bundled with this CLI. Mirrors `<cli>/data/skills/<name>/`.
const SKILL_NAMES = [
  "opper-api",
  "opper-cli",
  "opper-node-agents",
  "opper-node-sdk",
  "opper-python-agents",
  "opper-python-sdk",
] as const;

export type SkillTargetName = "claude" | "codex";

interface SkillTarget {
  name: SkillTargetName;
  /** Where SKILL.md folders go. */
  dir(): string;
  /**
   * True when this target is "live" on the current machine. Claude is
   * always considered live (we drop a directory; harmless if Claude isn't
   * installed). Codex is live only when the user has used it at least
   * once, so we don't materialise `~/.codex/` from nothing.
   */
  isLive(): boolean;
  /** Optional: register/unregister skills inside the target's own config. */
  register?(skillNames: readonly string[]): Promise<void>;
  unregister?(): Promise<void>;
}

function bundledSkillsDir(): string {
  // `<repo>/data/skills/` resolved relative to this file at both test
  // (src/setup/skills.ts) and runtime (dist/setup/skills.js) — both are
  // two levels deep from the repo root.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "data", "skills");
}

function claudeSkillsDir(): string {
  return (
    process.env.OPPER_SKILLS_HOME ??
    join(homedir(), ".claude", "skills")
  );
}

const CLAUDE_TARGET: SkillTarget = {
  name: "claude",
  dir: claudeSkillsDir,
  isLive: () => true,
};

const CODEX_TARGET: SkillTarget = {
  name: "codex",
  dir: codexSkillsDir,
  isLive: () => existsSync(codexHome()),
  register: registerCodexSkills,
  unregister: unregisterCodexSkills,
};

function liveTargets(): SkillTarget[] {
  return [CLAUDE_TARGET, CODEX_TARGET].filter((t) => t.isLive());
}

export function isSkillsInstalled(): boolean {
  for (const target of liveTargets()) {
    const dir = target.dir();
    if (!existsSync(dir)) continue;
    if (SKILL_NAMES.some((name) => existsSync(join(dir, name)))) return true;
  }
  return false;
}

/**
 * One entry per live target so callers can report exactly where the
 * skills landed (or didn't).
 */
export function installedTargets(): Array<{
  target: SkillTargetName;
  dir: string;
  installed: boolean;
}> {
  return liveTargets().map((target) => {
    const dir = target.dir();
    const installed =
      existsSync(dir) &&
      SKILL_NAMES.some((name) => existsSync(join(dir, name)));
    return { target: target.name, dir, installed };
  });
}

async function installToTarget(target: SkillTarget): Promise<void> {
  const src = bundledSkillsDir();
  const dest = target.dir();
  await mkdir(dest, { recursive: true });

  for (const name of SKILL_NAMES) {
    const srcPath = join(src, name);
    if (!existsSync(srcPath)) continue;
    const destPath = join(dest, name);
    await rm(destPath, { recursive: true, force: true });
    await cp(srcPath, destPath, { recursive: true });
  }

  if (target.register) await target.register(SKILL_NAMES);
}

export async function installSkills(): Promise<SkillTargetName[]> {
  const src = bundledSkillsDir();
  if (!existsSync(src)) {
    throw new OpperError(
      "API_ERROR",
      `Bundled skills directory missing at ${src}`,
      "Rebuild the CLI (`npm run build`) or reinstall from npm.",
    );
  }

  const targets = liveTargets();
  for (const target of targets) await installToTarget(target);
  return targets.map((t) => t.name);
}

export async function updateSkills(): Promise<SkillTargetName[]> {
  // Idempotent copy/overwrite — same as install.
  return installSkills();
}

export async function listInstalledSkills(): Promise<string[]> {
  // Use the first live target whose directory exists to enumerate.
  // (Both targets receive the same skill set, so reporting one is enough.)
  for (const target of liveTargets()) {
    const dir = target.dir();
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir);
    return entries.filter((e) => (SKILL_NAMES as readonly string[]).includes(e));
  }
  return [];
}

export async function uninstallSkills(): Promise<SkillTargetName[]> {
  const targets = liveTargets();
  for (const target of targets) {
    const dir = target.dir();
    for (const name of SKILL_NAMES) {
      const path = join(dir, name);
      if (existsSync(path)) {
        await rm(path, { recursive: true, force: true });
      }
    }
    if (target.unregister) await target.unregister();
  }
  return targets.map((t) => t.name);
}
