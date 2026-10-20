import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, posix, win32 } from "node:path";
import { readDesktopConfig } from "./codex-desktop-config.js";

export interface CodexCatalogLayers {
  codexHome?: string;
  /** Owned user configuration can be handled separately by persistent adapters. */
  includeUserConfig?: boolean;
}

/**
 * Preserve catalogs from local Codex configuration layers without fetching them.
 * This intentionally opts out even if another layer might shadow a catalog:
 * Codex owns precedence, including complete enforced provider replacement.
 */
export async function hasInheritedCodexCatalog(providerId: string, options: CodexCatalogLayers = {}): Promise<boolean> {
  const windows = platform() === "win32";
  const home = options.codexHome ?? (process.env.CODEX_HOME || join(homedir(), ".codex"));
  const system = windows ? win32.join(process.env.ProgramData || process.env.PROGRAMDATA || String.raw`C:\ProgramData`, "OpenAI", "Codex") : "/etc/codex";
  const systemPath = (name: string) => windows ? win32.join(system, name) : posix.join(system, name);
  const paths = [
    {path: systemPath("config.toml"), enforced: false},
    ...(options.includeUserConfig === false ? [] : [{path: join(home, "config.toml"), enforced: false}]),
    {path: windows ? join(home, "managed_config.toml") : systemPath("managed_config.toml"), enforced: true},
    {path: systemPath("requirements.toml"), enforced: true},
  ];
  try {
    const layers = await Promise.all(paths.map(async layer => {
      try { return {...layer, config: readDesktopConfig(await readFile(layer.path, "utf8"))}; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    }));
    const providers = new Set([providerId]);
    for (const layer of layers) {
      if (layer?.enforced && typeof layer.config.model_provider === "string") providers.add(layer.config.model_provider);
    }
    return layers.some(layer => {
      if (!layer) return false;
      if (Object.hasOwn(layer.config, "model_catalog_json")) return true;
      const definitions = layer.config.model_providers;
      if (!definitions || typeof definitions !== "object") return false;
      return [...providers].some(id => {
        const provider = (definitions as Record<string, unknown>)[id];
        return provider !== null && typeof provider === "object" && Object.hasOwn(provider, "model_catalog_url");
      });
    });
  } catch {
    // Preserve malformed/unreadable layers and let Codex report its own error.
    return true;
  }
}
