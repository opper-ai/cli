import { afterEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensurePrivateStateDirectory, ensurePrivateStateFile, assertPrivateStateFile, POWERSHELL_PRIVATE_STATE_SCRIPT } from "../../src/desktop/private-state.js";

const roots: string[] = [];
const execute = promisify(execFile);
const windows = process.platform === "win32";
afterEach(async () => {await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opper-private-state-")); roots.push(root);
  const directory = join(root, "private folder 'with' spaces å客户");
  await ensurePrivateStateDirectory(directory, true);
  return {root, directory, file: join(directory, "private 'state'.json")};
}

describe("private proxy state security", {timeout: windows ? 60_000 : 5_000, hookTimeout: windows ? 30_000 : 10_000}, () => {
  it("creates a private directory and empty file, verifies them, and preserves existing contents", async () => {
    const f = await fixture();
    await ensurePrivateStateDirectory(f.directory, true);
    await ensurePrivateStateFile(f.file, true);
    expect(await readFile(f.file, "utf8")).toBe("");
    await writeFile(f.file, "synthetic secret");
    await assertPrivateStateFile(f.file);
    await ensurePrivateStateFile(f.file, true);
    expect(await readFile(f.file, "utf8")).toBe("synthetic secret");
    if (!windows) {
      expect((await lstat(f.directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(f.file)).mode & 0o777).toBe(0o600);
    }
  });

  it("reports missing state and rejects wrong file types without creating them", async () => {
    const f = await fixture();
    const missing = join(f.root, "missing");
    await expect(ensurePrivateStateDirectory(missing)).rejects.toMatchObject({code: "ENOENT"});
    await expect(assertPrivateStateFile(f.file)).rejects.toMatchObject({code: "ENOENT"});
    await expect(assertPrivateStateFile(f.directory)).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
    await ensurePrivateStateFile(f.file, true);
    await expect(ensurePrivateStateDirectory(f.file, true)).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
    expect(await readFile(f.file, "utf8")).toBe("");
  });

  it.skipIf(windows)("rejects publicly readable state and never repairs existing permissions", async () => {
    const f = await fixture();
    await chmod(f.directory, 0o755);
    await expect(ensurePrivateStateDirectory(f.directory, true)).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
    expect((await lstat(f.directory)).mode & 0o777).toBe(0o755);
    await chmod(f.directory, 0o700);
    await ensurePrivateStateFile(f.file, true);
    await chmod(f.file, 0o644);
    await expect(ensurePrivateStateFile(f.file, true)).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
    expect((await lstat(f.file)).mode & 0o777).toBe(0o644);
  });

  it("rejects symlinked/junction state and creation through a Windows reparse point", async () => {
    const f = await fixture();
    const linked = join(f.root, "linked");
    await symlink(f.directory, linked, windows ? "junction" : "dir");
    await expect(ensurePrivateStateDirectory(linked, true)).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
    if (windows) {
      await expect(ensurePrivateStateDirectory(join(linked, "new"), true)).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
      await expect(lstat(join(f.directory, "new"))).rejects.toMatchObject({code: "ENOENT"});
    } else {
      await ensurePrivateStateFile(f.file, true);
      const fileLink = join(f.directory, "file-link");
      await symlink(f.file, fileLink);
      await expect(assertPrivateStateFile(fileLink)).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
    }
  });

  it.skipIf(!windows)("rejects native NTFS Everyone allow ACLs and never rewrites them", async () => {
    const f = await fixture();
    await execute("icacls.exe", [f.directory, "/grant", "*S-1-1-0:(R)"]);
    await expect(ensurePrivateStateDirectory(f.directory, true)).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
    const acl = await execute("icacls.exe", [f.directory]);
    expect(acl.stdout).toMatch(/Everyone|S-1-1-0/);
    // Repair this test-owned directory only, so file ACL rejection is independently exercised.
    await execute("icacls.exe", [f.directory, "/remove:g", "*S-1-1-0"]);
    await ensurePrivateStateFile(f.file, true);
    await execute("icacls.exe", [f.file, "/grant", "*S-1-1-0:(R)"]);
    await expect(assertPrivateStateFile(f.file)).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
    expect((await execute("icacls.exe", [f.file])).stdout).toMatch(/Everyone|S-1-1-0/);
  });

  it.skipIf(!windows)("rejects an unprotected directory DACL and empty file DACL", async () => {
    const f = await fixture();
    await execute("icacls.exe", [f.directory, "/inheritance:e"]);
    await expect(ensurePrivateStateDirectory(f.directory, true)).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
    await execute("icacls.exe", [f.directory, "/inheritance:r"]);
    await ensurePrivateStateFile(f.file, true);
    const command = "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); $p=[Console]::In.ReadToEnd(); $acl=New-Object System.Security.AccessControl.FileSecurity; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); [System.IO.File]::SetAccessControl($p,$acl)";
    try {
      await new Promise<void>((resolve, reject) => {
        const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], (err) => err ? reject(err) : resolve());
        child.stdin!.end(f.file);
      });
      await expect(assertPrivateStateFile(f.file)).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
    } finally {
      // Restore only this test-owned file, including when an assertion fails.
      await execute("icacls.exe", [f.file, "/reset"]);
    }
  });

  it.skipIf(!windows)("rejects parent takeover rights before creating state and before reading existing state", async () => {
    const f = await fixture();
    const parent = join(f.directory, "parent");
    await ensurePrivateStateDirectory(parent, true);
    const privateChild = join(parent, "private-child");
    await ensurePrivateStateDirectory(privateChild, true);
    const file = join(privateChild, "connection.json");
    await ensurePrivateStateFile(file, true);
    await writeFile(file, "synthetic secret");
    for (const permission of ["DC", "WDAC", "WO"]) {
      await execute("icacls.exe", [parent, "/grant", `*S-1-1-0:(${permission})`]);
      try {
        const newChild = join(parent, "must-not-be-created");
        await expect(ensurePrivateStateDirectory(newChild, true)).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
        await expect(lstat(newChild)).rejects.toMatchObject({code: "ENOENT"});
        await expect(assertPrivateStateFile(file)).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
        expect(await readFile(file, "utf8")).toBe("synthetic secret");
      } finally {await execute("icacls.exe", [parent, "/remove:g", "*S-1-1-0"]);}
    }
    for (const permission of ["WD", "AD"]) {
      await execute("icacls.exe", [parent, "/grant", `*S-1-1-0:(${permission})`]);
      try {
        await expect(ensurePrivateStateDirectory(join(parent, "must-not-be-created"), true)).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
        await expect(lstat(join(parent, "must-not-be-created"))).rejects.toMatchObject({code: "ENOENT"});
      } finally {await execute("icacls.exe", [parent, "/remove:g", "*S-1-1-0"]);}
    }
    await assertPrivateStateFile(file);
  });

  it("fails closed when the native Windows security checker cannot start", async () => {
    const f = await fixture();
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const originalRoot = process.env.SystemRoot;
    try {
      Object.defineProperty(process, "platform", {value: "win32", configurable: true});
      process.env.SystemRoot = join(f.root, "nonexistent-windows-root");
      await expect(ensurePrivateStateFile(f.file, true)).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
      await expect(lstat(f.file)).rejects.toMatchObject({code: "ENOENT"});
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
      if (originalRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalRoot;
    }
  });

  it("exports a reusable native script that receives paths as JSON data", () => {
    expect(POWERSHELL_PRIVATE_STATE_SCRIPT).toContain("[Console]::In.ReadToEnd()");
    expect(POWERSHELL_PRIVATE_STATE_SCRIPT).toContain("ConvertFrom-Json");
    expect(POWERSHELL_PRIVATE_STATE_SCRIPT).toContain("SetAccessRuleProtection($true, $false)");
    expect(POWERSHELL_PRIVATE_STATE_SCRIPT).toContain("$ancestorAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $trustedAncestorSids");
    expect(POWERSHELL_PRIVATE_STATE_SCRIPT).not.toContain("Invoke-Expression");
  });
});
