import { isSkillsInstalled, installSkills, updateSkills } from "../setup/skills.js";
import { brand } from "../ui/colors.js";

export async function skillsInstallCommand(): Promise<void> {
  if (isSkillsInstalled()) {
    console.log(
      `Opper skills already installed. Use ${brand.bold("opper skills update")} to refresh.`,
    );
    return;
  }
  await installSkills();
  console.log(brand.purple("✓ Opper skills installed."));
}

export async function skillsUpdateCommand(): Promise<void> {
  await updateSkills();
  console.log(brand.purple("✓ Opper skills updated."));
}

export async function skillsListCommand(): Promise<void> {
  if (isSkillsInstalled()) {
    console.log(`Opper skills: ${brand.purple("installed")}`);
  } else {
    console.log(
      `Opper skills: ${brand.dim("not installed")} — run ${brand.bold("opper skills install")}.`,
    );
  }
}
