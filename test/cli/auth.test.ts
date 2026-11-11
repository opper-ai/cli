import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import registerAuth from "../../src/cli/auth.js";
const manualLogin = vi.hoisted(() => vi.fn());
vi.mock("../../src/commands/manual-login.js", () => ({ manualLoginCommand: manualLogin }));
function program() {
  const cli = new Command().exitOverride().option("--key <slot>").option("--project-uuid <uuid>");
  registerAuth(cli, { key: () => "eager-default-must-not-be-used", projectUuid: () => cli.opts().projectUuid, version: "test" });
  return cli;
}
beforeEach(() => manualLogin.mockReset());
describe("manual CLI login", () => {
  it("leaves absent --key unresolved for the manual deployment choice", async () => {
    await program().parseAsync(["login"], { from: "user" });
    expect(manualLogin).toHaveBeenCalledExactlyOnceWith({});
  });
  it("forwards an explicitly empty base URL for validation instead of opening the chooser", async () => {
    await program().parseAsync(["login", "--base-url", ""], { from: "user" });
    expect(manualLogin).toHaveBeenCalledExactlyOnceWith({ baseUrl: "" });
  });
  it("preserves explicit slot, custom host, renewal, and project options", async () => {
    await program().parseAsync(["login", "--key", "custom", "--base-url", "https://custom.example", "--force", "--renew", "--project-uuid", "11111111-1111-4111-8111-111111111111"], { from: "user" });
    expect(manualLogin).toHaveBeenCalledExactlyOnceWith({ key: "custom", baseUrl: "https://custom.example", force: true, renew: true, projectUuid: "11111111-1111-4111-8111-111111111111" });
  });
});
