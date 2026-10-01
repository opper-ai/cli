import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { printTable } from "../ui/table.js";

export interface ProjectsListOptions {
  key: string;
  filter?: string;
}

interface Project {
  name: string | null;
  uuid: string;
}

export async function projectsListCommand(opts: ProjectsListOptions): Promise<void> {
  // Discovery is organization-wide; a saved resource target must not narrow
  // the list or prevent recovery when that target has been deleted.
  const api = new OpperApi(await resolveApiContext(opts.key));
  const projects = await api.get<Project[]>("/v1/projects");
  const filter = opts.filter?.toLowerCase();
  const rows = projects
    .filter((project) => !filter || (project.name ?? "").toLowerCase().includes(filter) ||
      project.uuid.toLowerCase().includes(filter))
    .map((project) => [project.name ?? "", project.uuid]);
  printTable(["NAME", "UUID"], rows);
}
