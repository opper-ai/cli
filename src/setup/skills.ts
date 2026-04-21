import { run } from "../util/run.js";
import { OpperError } from "../errors.js";

export function isSkillsInstalled(): boolean {
  const result = run("npx", ["skills", "list"]);
  if (result.code !== 0) return false;
  return result.stdout.toLowerCase().includes("opper");
}

export async function installSkills(): Promise<void> {
  const result = run("npx", ["skills", "add", "opper-ai/opper-skills"], {
    inherit: true,
  });
  if (result.code !== 0) {
    throw new OpperError(
      "API_ERROR",
      "Failed to install Opper skills",
      "Check that `npx skills` is available and try again.",
    );
  }
}

export async function updateSkills(): Promise<void> {
  const result = run("npx", ["skills", "update"], { inherit: true });
  if (result.code !== 0) {
    throw new OpperError(
      "API_ERROR",
      "Failed to update Opper skills",
      "Check that `npx skills` is available and try again.",
    );
  }
}
