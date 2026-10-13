import { afterEach, describe, expect, it, vi } from "vitest";
import { openBrowser, openLocalProxyBrowser } from "../../src/util/open-browser.js";

const child = vi.hoisted(() => ({ on: vi.fn(), unref: vi.fn() }));
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.clearAllMocks();
});

describe("browser handoff", () => {
  it("opens only a validated local proxy ticket with Windows Explorer", () => {
    Object.defineProperty(process, "platform", {value:"win32"});
    spawn.mockReturnValue(child);
    const url="http://127.0.0.1:19667/open/"+"a".repeat(48);
    openLocalProxyBrowser(url);
    expect(spawn).toHaveBeenCalledWith(expect.stringMatching(/explorer\.exe$/), [url], {stdio:"ignore",detached:true});
    expect(child.unref).toHaveBeenCalledOnce();
  });
  it.each(["https://attacker.example/open/abc", "http://localhost:19667/open/abc", "http://127.0.0.1:19667/open/abc?x=1", "http://127.0.0.1:19667/open/abc&calc.exe"])("refuses unsafe local-browser input %s", (url) => {
    Object.defineProperty(process, "platform", {value:"win32"});
    expect(() => openLocalProxyBrowser(url)).toThrow(/local proxy/);
    expect(spawn).not.toHaveBeenCalled();
  });
  it("uses the printed manual URL on Windows without spawning a shell", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    spawn.mockReturnValue(child);
    openBrowser("https://example.com/authorize?client_id=cli&redirect_uri=http%3A%2F%2F127.0.0.1&state=state");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([["darwin", "open"], ["linux", "xdg-open"]])("preserves the complete URL as a direct argument on %s", (value, command) => {
    Object.defineProperty(process, "platform", { value });
    spawn.mockReturnValue(child);
    const url = "https://example.com/authorize?client_id=cli&redirect_uri=http%3A%2F%2F127.0.0.1&state=state";
    openBrowser(url);
    expect(spawn).toHaveBeenCalledWith(command, [url], { stdio: "ignore", detached: true });
    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(child.unref).toHaveBeenCalledOnce();
  });
});
