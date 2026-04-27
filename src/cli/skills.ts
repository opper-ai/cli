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
    .description("Install bundled Opper skills into ~/.claude/skills/")
    .action(skillsInstallCommand);

  skills
    .command("update")
    .description("Update Opper skills to the latest version")
    .action(skillsUpdateCommand);

  skills
    .command("list")
    .description("Show whether Opper skills are installed")
    .action(skillsListCommand);

  skills
    .command("uninstall")
    .description("Remove Opper skills from ~/.claude/skills/")
    .action(skillsUninstallCommand);
};

export default register;
