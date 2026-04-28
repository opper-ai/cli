import { multiselect, isCancel } from "@clack/prompts";
import {
  skillsListCommand,
  skillsInstallCommand,
  skillsUpdateCommand,
  skillsUninstallCommand,
} from "../skills.js";
import { bundledSkills, listInstalledSkills } from "../../setup/skills.js";
import { brand } from "../../ui/colors.js";
import { pickMenuChoice, reportError } from "./shared.js";

export async function skillsMenu(): Promise<void> {
  while (true) {
    const choice = await pickMenuChoice("Skills", [
      { value: "status", label: "Status", hint: "Show install state per skill" },
      { value: "install", label: "Install…", hint: "Pick which bundled skills to install" },
      { value: "update", label: "Update", hint: "Refresh installed skills" },
      { value: "uninstall", label: "Uninstall…", hint: "Pick which Opper skills to remove" },
      { value: "back", label: brand.dim("← Back") },
    ]);
    if (!choice) return;

    try {
      switch (choice) {
        case "status":
          await skillsListCommand();
          break;
        case "install": {
          const picked = await pickSkillsToInstall();
          if (picked === null) break;
          await skillsInstallCommand(picked);
          break;
        }
        case "update":
          await skillsUpdateCommand();
          break;
        case "uninstall": {
          const picked = await pickSkillsToUninstall();
          if (picked === null) break;
          await skillsUninstallCommand(picked);
          break;
        }
      }
    } catch (err) {
      reportError(err);
    }
  }
}

async function pickSkillsToInstall(): Promise<string[] | null> {
  const bundled = bundledSkills();
  const installed = new Set(await listInstalledSkills());
  if (bundled.length === 0) return null;

  const options = bundled.map((name) => {
    const opt: { value: string; label: string; hint?: string } = {
      value: name,
      label: name,
    };
    if (installed.has(name)) opt.hint = "already installed";
    return opt;
  });

  const result = await multiselect({
    message: "Select skills to install (space toggles, enter confirms)",
    // clack's option type is invariant on hint?: string under
    // exactOptionalPropertyTypes; the runtime accepts the union we built.
    options: options as never,
    initialValues: bundled.filter((n) => !installed.has(n)),
    required: false,
  });
  if (isCancel(result)) return null;
  return result as string[];
}

async function pickSkillsToUninstall(): Promise<string[] | null> {
  const installed = await listInstalledSkills();
  if (installed.length === 0) return [];

  const result = await multiselect({
    message: "Select skills to uninstall",
    options: installed.map((name) => ({ value: name, label: name })),
    required: false,
  });
  if (isCancel(result)) return null;
  return result as string[];
}
