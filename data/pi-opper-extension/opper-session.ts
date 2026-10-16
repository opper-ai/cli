/**
 * Opper session extension for `opper launch pi`.
 *
 * Loaded explicitly from a private temporary directory. The catalog is also
 * temporary; the selected credential stays in the process environment. No
 * provider or extension files are written into the user's Pi configuration.
 * Registers the provider before startup model selection, then re-registers it
 * on every session boundary with two headers (same value):
 *
 *   X-Opper-Trace-Id       = uuid5(NS, <pi session>)
 *   X-Opper-Parent-Span-Id = uuid5(NS, <pi session>)
 *
 * The shared value groups a session's calls into one Opper trace, pins the
 * session to one provider for prompt-cache reuse, and — because parent == trace
 * — makes task-api auto-create one `session` root span so the session renders as
 * one tree. Deriving the id from pi's own session file means each pi session (a
 * /new, /resume, /fork, or /reset) gets its OWN session root. Child agents
 * launched through `opper launch pi` receive their own extension and session.
 *
 * Why session_start and not a per-request hook: pi's before_provider_request can
 * only rewrite the request body, not headers, so the headers are (re)applied via
 * registerProvider on the session boundary — pi applies provider changes to
 * subsequent requests immediately. Re-register the complete provider so the
 * catalog and routing survive each update.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Fixed namespace → deterministic, valid-UUID trace ids (Opper validates the
// trace_id as a UUID). The same session always maps to the same trace id.
const NS = Buffer.from("3f2504e04f8941d39a0c0305e82c3301", "hex");

function uuid5(name: string): string {
  const h = createHash("sha1").update(Buffer.concat([NS, Buffer.from(name)])).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

// Stable per-process fallback for ephemeral sessions (one-shot `-p`: no session
// file), so a launch still shares one trace.
let procSeed = "";

export default function (pi: any) {
  const apiKey = process.env.OPPER_API_KEY;
  const baseUrl = process.env.OPPER_BASE_URL;
  const catalogPath = process.env.OPPER_PI_CATALOG_PATH;
  if (!apiKey || !baseUrl || !catalogPath) return;
  const models = JSON.parse(readFileSync(catalogPath, "utf8"));
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("Invalid Opper Pi model catalog.");
  }
  const provider = {
    api: "openai-completions",
    apiKey,
    baseUrl,
    authHeader: true,
    models,
    headers: process.env.OPPER_PROJECT_UUID ? { "X-Opper-Project": process.env.OPPER_PROJECT_UUID } : {},
  };
  // Pi applies extension factories before selecting the initial model.
  pi.registerProvider("opper", provider);

  pi.on("session_start", (_event: any, ctx: any) => {
    let sid: string | undefined;
    try {
      sid = ctx?.sessionManager?.getSessionFile?.() ?? undefined;
    } catch {
      /* ephemeral */
    }
    if (!sid) {
      if (!procSeed) procSeed = `pi-proc-${process.pid}-${process.hrtime.bigint().toString()}`;
      sid = procSeed;
    }
    const tid = uuid5(sid);
    pi.registerProvider("opper", {
      ...provider,
      headers: {
        ...provider.headers,
        "X-Opper-Trace-Id": tid,
        "X-Opper-Parent-Span-Id": tid,
      },
    });
  });
}
