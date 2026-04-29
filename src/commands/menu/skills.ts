import {
  skillsListCommand,
  skillsInstallCommand,
  skillsUpdateCommand,
  skillsUninstallCommand,
} from "../skills.js";
import { brand } from "../../ui/colors.js";
import { pickMenuChoice, reportError } from "./shared.js";

export async function skillsMenu(): Promise<void> {
  while (true) {
    const choice = await pickMenuChoice("Skills", [
      { value: "status", label: "Status", hint: "Show install state per skill" },
      { value: "install", label: "Install", hint: "Run `npx skills add opper-ai/opper-skills`" },
      { value: "update", label: "Update", hint: "Refresh from opper-ai/opper-skills" },
      { value: "uninstall", label: "Uninstall", hint: "Remove Opper skills" },
      { value: "back", label: brand.dim("← Back") },
    ]);
    if (!choice) return;

    try {
      switch (choice) {
        case "status":
          await skillsListCommand();
          break;
        case "install":
          await skillsInstallCommand();
          break;
        case "update":
          await skillsUpdateCommand();
          break;
        case "uninstall":
          await skillsUninstallCommand();
          break;
      }
    } catch (err) {
      reportError(err);
    }
  }
}
