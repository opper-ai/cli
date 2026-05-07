import { randomUUID } from "node:crypto";

const KEY_REGEX = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const MAX_TAGS = 8;
const MAX_VALUE_BYTES = 256;

export function newSessionId(): string {
  return `sess_${randomUUID()}`;
}

export function validateTags(tags: Record<string, string>): void {
  const keys = Object.keys(tags);
  if (keys.length > MAX_TAGS) {
    throw new Error(`too many tags: max ${MAX_TAGS}`);
  }
  for (const k of keys) {
    if (!KEY_REGEX.test(k)) {
      throw new Error(`invalid tag key: ${k}`);
    }
    if (k.toLowerCase().startsWith("opper.")) {
      throw new Error(`reserved tag key: ${k}`);
    }
    const v = tags[k] ?? "";
    if (Buffer.byteLength(v, "utf8") > MAX_VALUE_BYTES) {
      throw new Error(`value too long for ${k}: max ${MAX_VALUE_BYTES} bytes`);
    }
  }
}

export function buildSessionBaseUrl(
  host: string,
  sessionId: string,
  tags: Record<string, string>,
): string {
  validateTags(tags);
  const sortedKeys = Object.keys(tags).sort();
  const pairs = sortedKeys.map(
    (k) => `/${k}:${encodeURIComponent(tags[k] ?? "")}`,
  );
  return `${host}/v3/session/${sessionId}${pairs.join("")}`;
}
