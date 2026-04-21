import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { printTable } from "../ui/table.js";

export interface ModelsListOptions {
  key: string;
  filter?: string;
}

interface ModelsResponse {
  models: Array<{
    id: string;
    name?: string;
    context_window?: number;
  }>;
}

export async function modelsListCommand(opts: ModelsListOptions): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const resp = await api.get<ModelsResponse>("/v3/models");
  const filter = opts.filter?.toLowerCase();
  const rows = resp.models
    .filter((m) =>
      filter
        ? (m.name ?? "").toLowerCase().includes(filter) ||
          m.id.toLowerCase().includes(filter)
        : true,
    )
    .map((m) => [
      m.name ?? "",
      m.id,
      m.context_window ? m.context_window.toString() : "",
    ]);
  printTable(["NAME", "ID", "CONTEXT"], rows);
}
