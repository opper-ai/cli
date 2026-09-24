import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  installOpenCodeLoginBridge,
  removeOpenCodeLoginBridge,
  openCodeLoginBridgePath,
} from "../../src/setup/opencode-login-bridge.js";

let home: string;
let previous: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "opper-bridge-"));
  previous = process.env.OPPER_EDITOR_HOME;
  process.env.OPPER_EDITOR_HOME = home;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.OPPER_EDITOR_HOME;
  else process.env.OPPER_EDITOR_HOME = previous;
  await rm(home, { recursive: true, force: true });
});

describe("OpenCode login bridge setup", () => {
  it("installs one managed global plugin without writing an API key or provider config", async () => {
    const result = await installOpenCodeLoginBridge();
    const file = await readFile(result.path, "utf8");
    expect(result.path).toBe(openCodeLoginBridgePath());
    expect(file).toContain("OpperLoginPlugin");
    expect(file).not.toContain("op_live_");
    await expect(readFile(join(home, ".config", "opencode", "opencode.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await removeOpenCodeLoginBridge()).toBe(true);
    await expect(readFile(result.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds the installed plugin to the selected CLI slot without storing a secret", async () => {
    const result = await installOpenCodeLoginBridge("finnova");
    const file = await readFile(result.path, "utf8");
    expect(file).toContain('const DEFAULT_SLOT = "finnova";');
    expect(file).toContain("process.env.OPPER_KEY_SLOT || DEFAULT_SLOT");
    expect(file).not.toContain("op_live_");
  });

  it("refuses to overwrite or remove a plugin file that the CLI does not own", async () => {
    const path = openCodeLoginBridgePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "export const CustomPlugin = async () => ({});\n");
    await expect(installOpenCodeLoginBridge()).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    await expect(removeOpenCodeLoginBridge()).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(await readFile(path, "utf8")).toContain("CustomPlugin");
  });
});
