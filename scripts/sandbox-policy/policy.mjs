import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
} from "node:fs";
import { isIP } from "node:net";

export const policyDirectory = () => join(homedir(), ".dune", "policy");
export const emptyPolicy = () => ({ version: 0, rules: {} });
export function validateHost(value) {
  if (typeof value !== "string" || value.length > 253)
    throw new Error(
      "Enter a hostname or IP address, without a URL path or port.",
    );
  const host = value.toLowerCase();
  if (
    !isIP(host) &&
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      host,
    )
  )
    throw new Error(
      "Enter a hostname or IP address, without a URL path or port.",
    );
  return host;
}
export function validatePolicy(value) {
  if (
    !value ||
    !Number.isSafeInteger(value.version) ||
    value.version < 0 ||
    !value.rules ||
    typeof value.rules !== "object" ||
    Array.isArray(value.rules) ||
    Object.keys(value.rules).length > 256
  )
    throw new Error("Invalid network policy.");
  for (const [host, action] of Object.entries(value.rules)) {
    if (validateHost(host) !== host || !["allow", "deny"].includes(action))
      throw new Error("Invalid network policy rule.");
  }
  return value;
}
export function readPolicy(directory = policyDirectory()) {
  try {
    const text = readFileSync(join(directory, "current.json"), "utf8");
    if (text.length > 65536) throw new Error("Network policy is too large.");
    return validatePolicy(JSON.parse(text));
  } catch (error) {
    if (error.code === "ENOENT") return emptyPolicy();
    throw error;
  }
}
export function changePolicy(
  version,
  host,
  action,
  directory = policyDirectory(),
) {
  host = validateHost(host);
  if (!["allow", "deny", "inherit"].includes(action))
    throw new Error("Invalid policy action.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "update.lock");
  const fd = openSync(lock, "wx", 0o600);
  try {
    const current = readPolicy(directory);
    if (version !== current.version)
      throw new Error("Policy changed. Refresh and try again.");
    const rules = { ...current.rules };
    if (action === "inherit") delete rules[host];
    else
      Object.defineProperty(rules, host, {
        value: action,
        enumerable: true,
        configurable: true,
      });
    const next = validatePolicy({ version: current.version + 1, rules });
    const text = JSON.stringify(next);
    if (text.length > 65536) throw new Error("Network policy is too large.");
    writeFileSync(join(directory, `v${next.version}.json`), text, {
      flag: "wx",
      mode: 0o600,
    });
    const temporary = join(directory, "current.next");
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, join(directory, "current.json"));
    return next;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
export function applyPolicy(network, policy) {
  const allowedDomains = new Set(network.allowedDomains);
  const deniedDomains = new Set(network.deniedDomains);
  for (const [host, action] of Object.entries(policy.rules)) {
    if (action === "allow") allowedDomains.add(host);
    else {
      allowedDomains.delete(host);
      deniedDomains.add(host);
    }
  }
  return {
    allowedDomains: [...allowedDomains],
    deniedDomains: [...deniedDomains],
  };
}
