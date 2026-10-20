import { afterEach, expect, it, vi } from "vitest";

// Simulate node:path on a Windows host while the adapter tests select Unix.
// Platform-specific system locations must not inherit the host's separators.
vi.mock("node:path",async()=>{
  const actual=await vi.importActual<typeof import("node:path")>("node:path");
  return {...actual,join:actual.win32.join};
});
vi.mock("node:os",async()=>({...await vi.importActual<typeof import("node:os")>("node:os"),platform:()=>"darwin"}));
const {readFile}=vi.hoisted(()=>({readFile:vi.fn()}));
vi.mock("node:fs/promises",()=>({readFile}));
const {hasInheritedCodexCatalog}=await import("../../src/setup/codex-inherited-catalog.js");
afterEach(()=>readFile.mockReset());
it("uses Unix system paths independently of the host path implementation",async()=>{
  readFile.mockImplementation(async(path:string)=>{
    if(path==="/etc/codex/config.toml") return '[model_providers.opper-cli]\nmodel_catalog_url="https://managed.invalid/models"';
    throw Object.assign(new Error("missing fixture"),{code:"ENOENT"});
  });
  expect(await hasInheritedCodexCatalog("opper-cli",{includeUserConfig:false,codexHome:"C:\\fixture"})).toBe(true);
  expect(readFile).toHaveBeenCalledWith("/etc/codex/config.toml","utf8");
  expect(readFile).toHaveBeenCalledWith("/etc/codex/requirements.toml","utf8");
  expect(readFile).toHaveBeenCalledWith("/etc/codex/managed_config.toml","utf8");
});
