import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import {
  getSlot,
  readConfig,
  replaceSlotIfUnchanged,
  setSlot,
  withConfigLock,
} from "../../src/auth/config.js";

const home = useTempOpperHome();

describe("auth config transactions", () => {
  it("releases the lock after a failed write transaction", async () => {
    await expect(withConfigLock(async () => { throw new Error("write failed"); })).rejects.toThrow("write failed");
    await setSlot("default", { apiKey: "after-error" });
    expect((await getSlot("default"))?.apiKey).toBe("after-error");
  });

  it("replaces a slot only when its full prior value is still present", async () => {
    await setSlot("default", { apiKey: "old", credentialId: "1", baseUrl: "https://old.example" });
    const expected = await getSlot("default");
    await setSlot("default", { apiKey: "newer", credentialId: "2" });

    expect(await replaceSlotIfUnchanged("default", expected, { apiKey: "stale" })).toBe(false);
    expect((await getSlot("default"))?.apiKey).toBe("newer");
    expect(await replaceSlotIfUnchanged("default", await getSlot("default"), { apiKey: "latest" })).toBe(true);
    expect((await getSlot("default"))?.apiKey).toBe("latest");
  });

  it("serializes a child process writer behind a held config lock", async () => {
    await setSlot("default", { apiKey: "original" });
    let release!: () => void;
    let entered!: () => void;
    const enteredLock = new Promise<void>((resolve) => { entered = resolve; });
    const held = withConfigLock(async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await enteredLock;

    const child = spawn(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e",
      "import { setSlot } from './src/auth/config.ts'; process.stdout.write('ready\\n'); await setSlot('child', { apiKey: 'child-key' }); process.stdout.write('done\\n');",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, OPPER_HOME: home.get() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const childExit = once(child, "exit");
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    try {
      await once(child.stdout, "data");
      await delay(150);
      expect(output).toContain("ready");
      expect(output).not.toContain("done");
      expect((await readConfig())?.keys.child).toBeUndefined();
    } finally {
      release();
      await held;
    }
    await childExit;
    expect(child.exitCode, errors).toBe(0);
    expect(output).toContain("done");
    expect((await readConfig())?.keys.child?.apiKey).toBe("child-key");
    expect((await readConfig())?.keys.default?.apiKey).toBe("original");
  });
});
