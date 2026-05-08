/**
 * Phase-1 scratch generator for the GitHub Copilot in VS Code BYOK
 * integration. Reads PICKER_MODELS and emits the two settings.json snippets
 * sitting next to this file:
 *
 *   - insiders-settings.json: native `github.copilot.chat.customOAIModels`
 *     block (works in VS Code Insiders 1.104+).
 *   - stable-settings.json: `oaicopilot.*` block consumed by the
 *     "OAI Compatible Provider for Copilot" community extension on stable.
 *
 * Run from the repo root:
 *   npx tsx docs/copilot-vscode/generate.ts
 *
 * When phase 2 promotes this to a real adapter, the logic here moves into
 * `src/agents/github-copilot-vscode.ts` and the capability table either
 * graduates onto `PickerModel` or sits beside the adapter.
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PICKER_MODELS } from "../../src/config/models.js";

const PROVIDER_URL = "https://api.opper.ai/v3/compat";
const PROVIDER_NAME = "Opper";
const DEFAULT_MAX_OUTPUT = 32_768;

// Conservative vision allowlist — flip during testing as we confirm each
// model's compat behaviour. Keeping non-vision off by default avoids the
// picker advertising image support that the upstream model can't honour.
const VISION = new Set<string>([
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "gpt-5.5",
  "gemini-3.1-pro-preview",
]);

const here = dirname(fileURLToPath(import.meta.url));

// Insiders' native customOAIModels uses an OBJECT keyed by model id, with
// each entry repeating the provider URL. The grouped-array shape (one
// provider, nested `models`) is a still-open feature request
// (microsoft/vscode#277102), not the implemented schema — using it
// registers the provider name but silently drops the model list.
const insidersBlock = {
  "github.copilot.chat.customOAIModels": Object.fromEntries(
    PICKER_MODELS.map((m) => [
      m.id,
      {
        name: `${PROVIDER_NAME} · ${m.id}`,
        url: PROVIDER_URL,
        requiresAPIKey: true,
        toolCalling: true,
        vision: VISION.has(m.id),
        thinking: m.reasoning,
        maxInputTokens: m.contextWindow,
        maxOutputTokens: DEFAULT_MAX_OUTPUT,
      },
    ]),
  ),
};

const stableBlock = {
  "oaicopilot.baseUrl": PROVIDER_URL,
  "oaicopilot.models": PICKER_MODELS.map((m) => ({
    id: m.id,
    owned_by: "opper",
    displayName: m.id,
    apiMode: "openai",
    context_length: m.contextWindow,
    max_tokens: DEFAULT_MAX_OUTPUT,
    vision: VISION.has(m.id),
    enable_thinking: m.reasoning,
  })),
};

await writeFile(
  join(here, "insiders-settings.json"),
  `${JSON.stringify(insidersBlock, null, 2)}\n`,
);
await writeFile(
  join(here, "stable-settings.json"),
  `${JSON.stringify(stableBlock, null, 2)}\n`,
);

console.log("wrote insiders-settings.json and stable-settings.json");
