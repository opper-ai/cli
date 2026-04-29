import {
  isSkillsInstalled,
  installSkills,
  updateSkills,
  uninstallSkills,
  installedTargets,
} from "../setup/skills.js";
import { brand } from "../ui/colors.js";

export async function skillsInstallCommand(): Promise<void> {
  if (isSkillsInstalled()) {
    console.log(
      `Opper skills already installed. Use ${brand.bold("opper skills update")} to refresh.`,
    );
    return;
  }
  const result = await installSkills();
  console.log(brand.accent(`✓ Installed Opper skills from ${result.source}.`));
}

export async function skillsUpdateCommand(): Promise<void> {
  const result = await updateSkills();
  console.log(brand.accent(`✓ Updated Opper skills from ${result.source}.`));
}

export async function skillsUninstallCommand(): Promise<void> {
  if (!isSkillsInstalled()) {
    console.log("Opper skills are not installed — nothing to do.");
    return;
  }
  const result = await uninstallSkills();
  console.log(brand.accent(`✓ Removed Opper skills (${result.source}).`));
}

export async function skillsListCommand(): Promise<void> {
  const status = installedTargets();
  if (status.length === 0) {
    console.log(brand.dim("No targets detected — install Claude or Codex first."));
    return;
  }

  // Union of every Opper skill present on any target → matrix rows.
  const allSkills = [
    ...new Set(status.flatMap((s) => s.installed)),
  ].sort();

  if (allSkills.length === 0) {
    console.log(
      `${brand.dim("No Opper skills installed.")} Run ${brand.bold("opper skills install")}.`,
    );
    for (const s of status) {
      console.log(`  ${s.target.padEnd(8)} ${brand.dim(s.dir)}`);
    }
    return;
  }

  const nameWidth = Math.max("SKILL".length, ...allSkills.map((n) => n.length));
  const colWidth = 12;

  console.log(
    brand.dim(
      [
        "SKILL".padEnd(nameWidth),
        ...status.map((s) => s.target.toUpperCase().padEnd(colWidth)),
      ].join("  "),
    ),
  );
  for (const skill of allSkills) {
    const cells = status.map((s) =>
      s.installed.includes(skill)
        ? brand.accent("installed".padEnd(colWidth))
        : brand.dim("—".padEnd(colWidth)),
    );
    console.log([skill.padEnd(nameWidth), ...cells].join("  "));
  }
  console.log(
    `\n${brand.dim("Dirs:")} ${status.map((s) => `${s.target}=${s.dir}`).join(", ")}`,
  );
}
