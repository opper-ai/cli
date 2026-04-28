import {
  isSkillsInstalled,
  installSkills,
  updateSkills,
  uninstallSkills,
  installedTargets,
  bundledSkills,
  type SkillsResult,
} from "../setup/skills.js";
import { brand } from "../ui/colors.js";

function suffix(result: SkillsResult): string {
  const parts: string[] = [];
  if (result.skills.length > 0) parts.push(result.skills.join(", "));
  if (result.targets.length > 0) parts.push(`→ ${result.targets.join(", ")}`);
  return parts.length ? ` (${parts.join("; ")})` : "";
}

export async function skillsInstallCommand(names?: string[]): Promise<void> {
  if (!names?.length && isSkillsInstalled()) {
    console.log(
      `Opper skills already installed. Use ${brand.bold("opper skills update")} to refresh, or pass skill names to add specific ones.`,
    );
    return;
  }
  const result = await installSkills(names);
  console.log(brand.purple(`✓ Installed${suffix(result)}.`));
}

export async function skillsUpdateCommand(names?: string[]): Promise<void> {
  const result = await updateSkills(names);
  console.log(brand.purple(`✓ Updated${suffix(result)}.`));
}

export async function skillsUninstallCommand(names?: string[]): Promise<void> {
  if (!isSkillsInstalled()) {
    console.log("Opper skills are not installed — nothing to do.");
    return;
  }
  const result = await uninstallSkills(names);
  console.log(brand.purple(`✓ Uninstalled${suffix(result)}.`));
}

export async function skillsListCommand(): Promise<void> {
  const status = installedTargets();
  const bundled = bundledSkills();

  if (status.length === 0) {
    console.log(
      `${brand.dim("No targets detected — install Claude or Codex first.")}`,
    );
    return;
  }

  // Per-skill matrix across targets so it's obvious where each one lives.
  const targetNames = status.map((s) => s.target);
  const nameWidth = Math.max("SKILL".length, ...bundled.map((n) => n.length));
  const colWidth = 12;

  console.log(
    brand.dim(
      [
        "SKILL".padEnd(nameWidth),
        ...targetNames.map((t) => t.toUpperCase().padEnd(colWidth)),
      ].join("  "),
    ),
  );

  for (const skill of bundled) {
    const cells = status.map((s) => {
      const installed = s.installed.includes(skill);
      return installed
        ? brand.purple("installed".padEnd(colWidth))
        : brand.dim("—".padEnd(colWidth));
    });
    console.log([skill.padEnd(nameWidth), ...cells].join("  "));
  }

  console.log(
    `\n${brand.dim("Dirs:")} ${status.map((s) => `${s.target}=${s.dir}`).join(", ")}`,
  );
}
