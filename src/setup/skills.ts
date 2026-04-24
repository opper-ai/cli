import { cp, mkdir, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OpperError } from "../errors.js";

// Skills bundled with this CLI. Mirrors `<cli>/data/skills/<name>/`.
const SKILL_NAMES = [
  "opper-api",
  "opper-cli",
  "opper-node-agents",
  "opper-node-sdk",
  "opper-python-agents",
  "opper-python-sdk",
] as const;

function bundledSkillsDir(): string {
  // `<repo>/data/skills/` resolved relative to this file at both test
  // (src/setup/skills.ts) and runtime (dist/setup/skills.js) — both are
  // two levels deep from the repo root.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "data", "skills");
}

function installDir(): string {
  return (
    process.env.OPPER_SKILLS_HOME ??
    join(homedir(), ".claude", "skills")
  );
}

export function isSkillsInstalled(): boolean {
  const dir = installDir();
  if (!existsSync(dir)) return false;
  return SKILL_NAMES.some((name) => existsSync(join(dir, name)));
}

export async function installSkills(): Promise<void> {
  const src = bundledSkillsDir();
  if (!existsSync(src)) {
    throw new OpperError(
      "API_ERROR",
      `Bundled skills directory missing at ${src}`,
      "Rebuild the CLI (`npm run build`) or reinstall from npm.",
    );
  }

  const dest = installDir();
  await mkdir(dest, { recursive: true });

  for (const name of SKILL_NAMES) {
    const srcPath = join(src, name);
    if (!existsSync(srcPath)) continue;
    const destPath = join(dest, name);
    await rm(destPath, { recursive: true, force: true });
    await cp(srcPath, destPath, { recursive: true });
  }
}

export async function updateSkills(): Promise<void> {
  // Idempotent copy/overwrite — same as install.
  await installSkills();
}

export async function listInstalledSkills(): Promise<string[]> {
  const dir = installDir();
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries.filter((e) =>
    (SKILL_NAMES as readonly string[]).includes(e),
  );
}
