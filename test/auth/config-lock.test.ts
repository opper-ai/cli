import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
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
  it("recovers an abandoned empty lock after a restart, including competing writers", async () => {
    const lock = join(home.get(), "config.json.lock");
    await mkdir(lock, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);

    await Promise.all([
      setSlot("first", { apiKey: "first-key" }),
      setSlot("second", { apiKey: "second-key" }),
    ]);
    expect((await readConfig())?.keys).toMatchObject({
      first: { apiKey: "first-key" }, second: { apiKey: "second-key" },
    });
  }, 25_000);

  it("recovers the lock after its writer is killed", async () => {
    const child = spawn(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e",
      "import { withConfigLock } from './src/auth/config.ts'; await withConfigLock(async () => { process.send('locked'); await new Promise(() => { setInterval(() => {}, 1000); }); });",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, OPPER_HOME: home.get() },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const exited = once(child, "exit");
    try {
      await once(child, "message");
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
    await setSlot("recovered", { apiKey: "after-crash" });
    expect((await getSlot("recovered"))?.apiKey).toBe("after-crash");
  }, 25_000);

  it("does not reclaim a recent empty lock", async () => {
    const lock = join(home.get(), "config.json.lock");
    await mkdir(lock, { recursive: true });
    let completed = false;
    const write = setSlot("waiting", { apiKey: "after-stale" }).then(() => { completed = true; });
    try {
      await delay(150);
      expect(completed).toBe(false);
      expect(await readConfig()).toBeNull();
    } finally {
      const old = new Date(Date.now() - 60_000);
      await utimes(lock, old, old);
      await write;
    }
    expect((await getSlot("waiting"))?.apiKey).toBe("after-stale");
  });

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
      // Longer than the stale threshold: a live writer must refresh its lease.
      await delay(11_000);
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
  }, 25_000);
});
