import {
  skillsInstallCommand,
  skillsUpdateCommand,
  skillsListCommand,
  skillsUninstallCommand,
} from "../commands/skills.js";
import type { RegisterFn } from "./types.js";

const register: RegisterFn = (program) => {
  const skills = program.command("skills").description("Manage Opper skills");

  skills
    .command("install")
    .description("Install bundled Opper skills (all if none specified)")
    .argument("[names...]", "skill names to install (default: all bundled)")
    .action(async (names: string[]) => {
      await skillsInstallCommand(names);
    });

  skills
    .command("update")
    .description("Update installed Opper skills (or specific ones by name)")
    .argument("[names...]", "skill names to update (default: all installed)")
    .action(async (names: string[]) => {
      await skillsUpdateCommand(names);
    });

  skills
    .command("list")
    .description("Show per-skill install state across each target")
    .action(skillsListCommand);

  skills
    .command("uninstall")
    .description("Remove Opper skills (all installed if none specified)")
    .argument("[names...]", "skill names to remove (default: all installed)")
    .action(async (names: string[]) => {
      await skillsUninstallCommand(names);
    });
};

export default register;
