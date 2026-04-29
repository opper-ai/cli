import {
  skillsInstallCommand,
  skillsUpdateCommand,
  skillsListCommand,
  skillsUninstallCommand,
} from "../commands/skills.js";
import type { RegisterFn } from "./types.js";

const register: RegisterFn = (program) => {
  const skills = program
    .command("skills")
    .description("Manage Opper skills (delegates to `npx skills`)");

  skills
    .command("install")
    .description("Install Opper skills from opper-ai/opper-skills")
    .action(skillsInstallCommand);

  skills
    .command("update")
    .description("Update Opper skills to the latest from opper-ai/opper-skills")
    .action(skillsUpdateCommand);

  skills
    .command("list")
    .description("Show per-skill install state across each target")
    .action(skillsListCommand);

  skills
    .command("uninstall")
    .description("Remove Opper skills installed from opper-ai/opper-skills")
    .action(skillsUninstallCommand);
};

export default register;
