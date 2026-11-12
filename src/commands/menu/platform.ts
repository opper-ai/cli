import { autocomplete, isCancel, text } from "@clack/prompts";
import { chatCommand } from "../chat.js";
import { OpperApi } from "../../api/client.js";
import { resolveApiContext } from "../../api/resolve.js";
import { OpperError } from "../../errors.js";
import { modelsListCommand } from "../models.js";
import { projectsListCommand } from "../projects.js";
import {
  tracesListCommand,
  tracesGetCommand,
  tracesDeleteCommand,
} from "../traces.js";
import {
  indexesListCommand,
  indexesGetCommand,
  indexesCreateCommand,
  indexesDeleteCommand,
  indexesQueryCommand,
} from "../indexes.js";
import { usageListCommand } from "../usage.js";
import { brand } from "../../ui/colors.js";
import {
  ask,
  askConfirm,
  pickMenuChoice,
  reportError,
  type MenuOptions,
} from "./shared.js";

export async function platformMenu(opts: MenuOptions): Promise<void> {
  while (true) {
    const choice = await pickMenuChoice("Opper", [
      { value: "projects", label: "Projects", hint: "Project names and UUIDs" },
      { value: "models", label: "Models", hint: "Available models" },
      { value: "indexes", label: "Indexes", hint: "Knowledge bases" },
      { value: "traces", label: "Traces", hint: "Execution traces" },
      { value: "usage", label: "Usage", hint: "Tokens & cost" },
      { value: "chat", label: "Chat…", hint: "Send a prompt to an available model" },
      { value: "back", label: brand.dim("← Back") },
    ]);
    if (!choice) return;

    try {
      switch (choice) {
        case "projects":
          await projectsListCommand({ key: opts.key });
          break;
        case "models":
          await modelsListCommand({ key: opts.key, ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}) });
          break;
        case "indexes":
          await indexesMenu(opts);
          break;
        case "traces":
          await tracesMenu(opts);
          break;
        case "usage":
          await usageListCommand({ key: opts.key, ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}) });
          break;
        case "chat":
          await chatWizard(opts);
          break;
      }
    } catch (err) {
      reportError(err);
    }
  }
}

async function tracesMenu(opts: MenuOptions): Promise<void> {
  while (true) {
    const choice = await pickMenuChoice("Traces", [
      { value: "list", label: "List", hint: "Recent traces" },
      { value: "get", label: "Get…", hint: "Show a trace by id" },
      { value: "delete", label: "Delete…", hint: "Delete a trace by id" },
      { value: "back", label: brand.dim("← Back") },
    ]);
    if (!choice) return;

    try {
      switch (choice) {
        case "list":
          await tracesListCommand({ key: opts.key, ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}) });
          break;
        case "get": {
          const id = await ask("Trace id", { required: true });
          if (!id) continue;
          await tracesGetCommand({ id, key: opts.key, ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}) });
          break;
        }
        case "delete": {
          const id = await ask("Trace id", { required: true });
          if (!id) continue;
          if (!(await askConfirm(`Delete trace "${id}"?`))) continue;
          await tracesDeleteCommand({ id, key: opts.key, ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}) });
          break;
        }
      }
    } catch (err) {
      reportError(err);
    }
  }
}

async function indexesMenu(opts: MenuOptions): Promise<void> {
  while (true) {
    const choice = await pickMenuChoice("Indexes", [
      { value: "list", label: "List", hint: "All knowledge bases" },
      { value: "get", label: "Get…", hint: "Show details of an index" },
      { value: "create", label: "Create…", hint: "New empty index" },
      { value: "delete", label: "Delete…", hint: "Remove an index" },
      { value: "query", label: "Query…", hint: "Semantic search" },
      { value: "back", label: brand.dim("← Back") },
    ]);
    if (!choice) return;

    try {
      switch (choice) {
        case "list":
          await indexesListCommand({ key: opts.key, ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}) });
          break;
        case "get": {
          const name = await ask("Index name", { required: true });
          if (!name) continue;
          await indexesGetCommand({ name, key: opts.key, ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}) });
          break;
        }
        case "create": {
          const name = await ask("New index name", { required: true });
          if (!name) continue;
          await indexesCreateCommand({ name, key: opts.key, ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}) });
          break;
        }
        case "delete": {
          const name = await ask("Index name", { required: true });
          if (!name) continue;
          if (!(await askConfirm(`Delete index "${name}"?`))) continue;
          await indexesDeleteCommand({ name, key: opts.key, ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}) });
          break;
        }
        case "query": {
          const name = await ask("Index name", { required: true });
          if (!name) continue;
          const query = await ask("Query", { required: true });
          if (!query) continue;
          await indexesQueryCommand({ name, query, key: opts.key, ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}) });
          break;
        }
      }
    } catch (err) {
      reportError(err);
    }
  }
}

async function chatWizard(opts: MenuOptions): Promise<void> {
  const prompt = await ask("Prompt", { required: true });
  if (!prompt) return;
  // The shared ask helper treats blank input as cancellation. Here blank means
  // no system instructions, while Escape must stop before any API request.
  const system = await text({ message: "System instructions (optional)" });
  if (isCancel(system)) return;

  const context = await resolveApiContext(opts.key, {
    ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}),
  });
  const catalog = await new OpperApi(context).get<{ data?: unknown }>("/v3/compat/models");
  const ids = Array.isArray(catalog?.data)
    ? [...new Set(catalog.data.flatMap((model: unknown) => {
      if (!model || typeof model !== "object" || !("id" in model)
        || typeof model.id !== "string" || !model.id || /\s|[\u0000-\u001f\u007f]/.test(model.id)) return [];
      const metadata = "opper" in model ? model.opper : undefined;
      if (metadata && typeof metadata === "object" && "type" in metadata && metadata.type === "embedding") return [];
      return [model.id];
    }))]
    : [];
  if (ids.length === 0) {
    throw new OpperError("API_ERROR", "No chat models are available for the selected account.",
      "Run `opper models list` to check model access, or choose another deployment.");
  }
  const model = await autocomplete({
    message: "Model (type to filter)",
    options: ids.map(id => ({ value: id, label: id })),
  });
  if (isCancel(model) || typeof model !== "string") return;
  if (!ids.includes(model)) {
    throw new OpperError("API_ERROR", "The selected model is no longer available.", "Choose a model from the current list and retry.");
  }
  const systemText = typeof system === "string" ? system.trim() : "";
  await chatCommand({
    prompt,
    model,
    key: opts.key,
    ...(systemText ? { system: systemText } : {}),
    ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}),
  });
}
