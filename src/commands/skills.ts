import {
  isSkillsInstalled,
  installSkills,
  updateSkills,
  uninstallSkills,
  installedTargets,
} from "../setup/skills.js";
import { brand } from "../ui/colors.js";

function targetsLine(targets: ReadonlyArray<string>): string {
  if (targets.length === 0) return "";
  return ` (${targets.join(", ")})`;
}

export async function skillsInstallCommand(): Promise<void> {
  if (isSkillsInstalled()) {
    console.log(
      `Opper skills already installed. Use ${brand.bold("opper skills update")} to refresh.`,
    );
    return;
  }
  const targets = await installSkills();
  console.log(brand.purple(`✓ Opper skills installed${targetsLine(targets)}.`));
}

export async function skillsUpdateCommand(): Promise<void> {
  const targets = await updateSkills();
  console.log(brand.purple(`✓ Opper skills updated${targetsLine(targets)}.`));
}

export async function skillsUninstallCommand(): Promise<void> {
  if (!isSkillsInstalled()) {
    console.log("Opper skills are not installed — nothing to do.");
    return;
  }
  const targets = await uninstallSkills();
  console.log(brand.purple(`✓ Opper skills uninstalled${targetsLine(targets)}.`));
}

export async function skillsListCommand(): Promise<void> {
  const status = installedTargets();
  if (status.length === 0) {
    console.log(
      `Opper skills: ${brand.dim("no targets detected")} — install Claude or Codex first.`,
    );
    return;
  }
  for (const s of status) {
    const state = s.installed
      ? brand.purple("installed")
      : brand.dim("not installed");
    console.log(`${s.target.padEnd(8)} ${state}  ${brand.dim(s.dir)}`);
  }
  if (!status.some((s) => s.installed)) {
    console.log(
      `\nRun ${brand.bold("opper skills install")} to install for ${status.map((s) => s.target).join(" + ")}.`,
    );
  }
}
