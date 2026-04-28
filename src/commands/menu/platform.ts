import { callCommand } from "../call.js";
import { modelsListCommand } from "../models.js";
import {
  functionsListCommand,
  functionsGetCommand,
  functionsDeleteCommand,
} from "../functions.js";
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
      { value: "functions", label: "Functions", hint: "Saved functions in your project" },
      { value: "models", label: "Models", hint: "Available models" },
      { value: "indexes", label: "Indexes", hint: "Knowledge bases" },
      { value: "traces", label: "Traces", hint: "Execution traces" },
      { value: "usage", label: "Usage", hint: "Tokens & cost" },
      { value: "call", label: "Call function…", hint: "Run an Opper function with custom inputs" },
      { value: "back", label: brand.dim("← Back") },
    ]);
    if (!choice) return;

    try {
      switch (choice) {
        case "functions":
          await functionsMenu(opts);
          break;
        case "models":
          await modelsListCommand({ key: opts.key });
          break;
        case "indexes":
          await indexesMenu(opts);
          break;
        case "traces":
          await tracesMenu(opts);
          break;
        case "usage":
          await usageListCommand({ key: opts.key });
          break;
        case "call":
          await callWizard(opts);
          break;
      }
    } catch (err) {
      reportError(err);
    }
  }
}

async function functionsMenu(opts: MenuOptions): Promise<void> {
  while (true) {
    const choice = await pickMenuChoice("Functions", [
      { value: "list", label: "List", hint: "Show all functions" },
      { value: "get", label: "Get…", hint: "Show details of a function" },
      { value: "delete", label: "Delete…", hint: "Delete a function" },
      { value: "back", label: brand.dim("← Back") },
    ]);
    if (!choice) return;

    try {
      switch (choice) {
        case "list":
          await functionsListCommand({ key: opts.key });
          break;
        case "get": {
          const name = await ask("Function name", { required: true });
          if (!name) continue;
          await functionsGetCommand({ name, key: opts.key });
          break;
        }
        case "delete": {
          const name = await ask("Function name", { required: true });
          if (!name) continue;
          if (!(await askConfirm(`Delete function "${name}"?`))) continue;
          await functionsDeleteCommand({ name, key: opts.key });
          break;
        }
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
          await tracesListCommand({ key: opts.key });
          break;
        case "get": {
          const id = await ask("Trace id", { required: true });
          if (!id) continue;
          await tracesGetCommand({ id, key: opts.key });
          break;
        }
        case "delete": {
          const id = await ask("Trace id", { required: true });
          if (!id) continue;
          if (!(await askConfirm(`Delete trace "${id}"?`))) continue;
          await tracesDeleteCommand({ id, key: opts.key });
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
          await indexesListCommand({ key: opts.key });
          break;
        case "get": {
          const name = await ask("Index name", { required: true });
          if (!name) continue;
          await indexesGetCommand({ name, key: opts.key });
          break;
        }
        case "create": {
          const name = await ask("New index name", { required: true });
          if (!name) continue;
          await indexesCreateCommand({ name, key: opts.key });
          break;
        }
        case "delete": {
          const name = await ask("Index name", { required: true });
          if (!name) continue;
          if (!(await askConfirm(`Delete index "${name}"?`))) continue;
          await indexesDeleteCommand({ name, key: opts.key });
          break;
        }
        case "query": {
          const name = await ask("Index name", { required: true });
          if (!name) continue;
          const query = await ask("Query", { required: true });
          if (!query) continue;
          await indexesQueryCommand({ name, query, key: opts.key });
          break;
        }
      }
    } catch (err) {
      reportError(err);
    }
  }
}

async function callWizard(opts: MenuOptions): Promise<void> {
  const name = await ask("Function name", { required: true });
  if (!name) return;
  const instructions = await ask("Instructions / system prompt", { required: true });
  if (!instructions) return;
  const input = await ask("Input", { required: true });
  if (!input) return;
  const model = await ask("Model id (leave empty for default)");

  await callCommand({
    name,
    instructions,
    input,
    key: opts.key,
    ...(model ? { model } : {}),
  });
}
