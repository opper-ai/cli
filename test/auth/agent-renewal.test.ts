import { beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { renewAgentCredential } from "../../src/auth/agent-renewal.js";

vi.mock("node:child_process", () => ({ fork: vi.fn() }));
let worker: EventEmitter & { send: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };
beforeEach(() => {
  worker = Object.assign(new EventEmitter(), { send: vi.fn(), kill: vi.fn() });
  vi.mocked(fork).mockReturnValue(worker as never);
});
const previous = { apiKey: "synthetic-old", source: "device-flow" as const, credentialId: "1" };

it.each([
  ["https://api.opper.ai", "https://platform.opper.ai/activate"],
  ["https://api.evroc.on.opper.ai", "https://evroc.on.opper.ai/activate"],
])("allows only the matching known platform for %s", async (baseUrl, url) => {
  const onPrompt = vi.fn();
  const result = renewAgentCredential({ baseUrl, previous, signal: new AbortController().signal, onPrompt });
  worker.emit("message", { type: "prompt", prompt: { verificationUri: url, userCode: "TEST" } });
  worker.emit("message", { type: "result", slot: { apiKey: "synthetic-new", baseUrl } });
  await expect(result).resolves.toMatchObject({ apiKey: "synthetic-new" });
  expect(onPrompt).toHaveBeenCalledWith({ url, code: "TEST" });
  expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({ baseUrl, renew: true }));
});

it.each([
  ["https://api.evroc.on.opper.ai", "https://platform.opper.ai/activate"],
  ["https://api.opper.ai", "https://evroc.on.opper.ai/activate"],
  ["https://api.evroc.on.opper.ai", "https://evroc.on.opper.ai.example/activate"],
  ["https://unregistered.example", "https://platform.opper.ai/activate"],
])("refuses cross-deployment or unknown approval destinations for %s", async (baseUrl, url) => {
  const onPrompt = vi.fn();
  const result = renewAgentCredential({ baseUrl, previous, signal: new AbortController().signal, onPrompt });
  worker.emit("message", { type: "prompt", prompt: { verificationUri: url, userCode: "TEST" } });
  worker.emit("message", { type: "result", slot: { apiKey: "synthetic-new", baseUrl } });
  await expect(result).rejects.toThrow("Unexpected Opper approval website");
  expect(onPrompt).not.toHaveBeenCalled();
  expect(worker.kill).toHaveBeenCalled();
});
