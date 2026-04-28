import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
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
  /**
   * Optional: rewrite the target's own config so the on-disk skills are
   * actually enabled. Called with the full list of currently-installed
   * Opper skill names after every mutation, so the registry never drifts
   * out of sync with the filesystem.
   */
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

/** All skill folders shipped inside `data/skills/`. Discovered, not hard-coded. */
export function bundledSkills(): string[] {
  const dir = bundledSkillsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory()
          && existsSync(join(dir, name, "SKILL.md"));
      } catch {
        return false;
      }
    })
    .sort();
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

/** Names of bundled skills currently present in the given target dir. */
function installedSkillsIn(target: SkillTarget, bundled: readonly string[]): string[] {
  const dir = target.dir();
  if (!existsSync(dir)) return [];
  return bundled.filter((name) => existsSync(join(dir, name, "SKILL.md")));
}

export function isSkillsInstalled(): boolean {
  const bundled = bundledSkills();
  for (const target of liveTargets()) {
    if (installedSkillsIn(target, bundled).length > 0) return true;
  }
  return false;
}

export interface TargetStatus {
  target: SkillTargetName;
  dir: string;
  installed: string[];
}

/** One entry per live target, listing the bundled skills present in each. */
export function installedTargets(): TargetStatus[] {
  const bundled = bundledSkills();
  return liveTargets().map((target) => ({
    target: target.name,
    dir: target.dir(),
    installed: installedSkillsIn(target, bundled),
  }));
}

function validateNames(names: readonly string[], bundled: readonly string[]): void {
  const unknown = names.filter((n) => !bundled.includes(n));
  if (unknown.length > 0) {
    throw new OpperError(
      "API_ERROR",
      `Unknown skill(s): ${unknown.join(", ")}`,
      `Available: ${bundled.join(", ")}`,
    );
  }
}

async function syncRegistry(target: SkillTarget, bundled: readonly string[]): Promise<void> {
  if (!target.register) return;
  const installed = installedSkillsIn(target, bundled);
  if (installed.length === 0) {
    if (target.unregister) await target.unregister();
  } else {
    await target.register(installed);
  }
}

export interface SkillsResult {
  targets: SkillTargetName[];
  skills: string[];
}

/**
 * Install a subset (or all) of the bundled skills into every live target.
 * Pass `names` to pick specific skills; omit to install everything.
 */
export async function installSkills(names?: readonly string[]): Promise<SkillsResult> {
  const src = bundledSkillsDir();
  if (!existsSync(src)) {
    throw new OpperError(
      "API_ERROR",
      `Bundled skills directory missing at ${src}`,
      "Rebuild the CLI (`npm run build`) or reinstall from npm.",
    );
  }

  const bundled = bundledSkills();
  if (bundled.length === 0) {
    throw new OpperError(
      "API_ERROR",
      "No bundled skills found",
      "Reinstall the CLI from npm.",
    );
  }

  const toInstall = names && names.length > 0 ? [...names] : bundled;
  validateNames(toInstall, bundled);

  const targets = liveTargets();
  for (const target of targets) {
    const dest = target.dir();
    await mkdir(dest, { recursive: true });

    for (const name of toInstall) {
      const srcPath = join(src, name);
      const destPath = join(dest, name);
      await rm(destPath, { recursive: true, force: true });
      await cp(srcPath, destPath, { recursive: true });
    }

    await syncRegistry(target, bundled);
  }

  return { targets: targets.map((t) => t.name), skills: toInstall };
}

export async function updateSkills(names?: readonly string[]): Promise<SkillsResult> {
  // If no names given, refresh everything currently installed (across any
  // target) — preserving the user's selection when they originally picked
  // a subset. Falls back to all bundled when nothing is installed yet.
  if (!names || names.length === 0) {
    const bundled = bundledSkills();
    const installedAcross = new Set<string>();
    for (const target of liveTargets()) {
      for (const name of installedSkillsIn(target, bundled)) {
        installedAcross.add(name);
      }
    }
    const refresh = installedAcross.size > 0 ? [...installedAcross] : bundled;
    return installSkills(refresh);
  }
  return installSkills(names);
}

export async function listInstalledSkills(): Promise<string[]> {
  const bundled = bundledSkills();
  const seen = new Set<string>();
  for (const target of liveTargets()) {
    for (const name of installedSkillsIn(target, bundled)) seen.add(name);
  }
  return [...seen].sort();
}

export async function uninstallSkills(names?: readonly string[]): Promise<SkillsResult> {
  const bundled = bundledSkills();
  const toRemove = names && names.length > 0
    ? [...names]
    : await listInstalledSkills();
  validateNames(toRemove, bundled);

  const targets = liveTargets();
  for (const target of targets) {
    const dir = target.dir();
    for (const name of toRemove) {
      const path = join(dir, name);
      if (existsSync(path)) {
        await rm(path, { recursive: true, force: true });
      }
    }
    await syncRegistry(target, bundled);
  }
  return { targets: targets.map((t) => t.name), skills: toRemove };
}
