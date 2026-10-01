import { pathToFileURL } from "node:url";
import { assetPath } from "../util/assets.js";
import { configPath, opperHome } from "../auth/paths.js";
import { getSlot, replaceSlotIfUnchanged, type AuthSlot } from "../auth/config.js";
import { renewAgentCredential } from "../auth/agent-renewal.js";
import { openBrowser } from "../util/open-browser.js";
import { which } from "../util/which.js";
import { OpperError } from "../errors.js";
import type { AgentAdapter } from "./types.js";

export const copilot: AgentAdapter = {
  name: "copilot",
  displayName: "GitHub Copilot CLI",
  docsUrl: "https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli",
  // Uses the pinned upstream npm package without a global Copilot install.
  async detect() { return { installed: Boolean(await which("npx")) }; },
  async isConfigured() { return Boolean(await which("npx")); },
  async configure() { throw new OpperError("INVALID_ARGUMENT", "Use `opper launch copilot`. One-time setup for plain copilot is not available yet."); },
  async unconfigure() { /* Launch configuration is temporary and removed on exit. */ },
  async spawn(args, routing) {
    const { launchCopilot } = await import(pathToFileURL(assetPath("copilot/launch.mjs")).href);
    return launchCopilot(args, routing, {
      home: opperHome(), configPath: configPath(), getSlot,
      replaceSlot: replaceSlotIfUnchanged, openBrowser,
      async renew({ previous, signal, onPrompt }: {
        previous: AuthSlot; signal: AbortSignal;
        onPrompt: (prompt: {url: string; code: string}) => void;
      }) {
        return renewAgentCredential({previous,signal,onPrompt,baseUrl:routing.apiBaseUrl});
      },
    });
  },
};
