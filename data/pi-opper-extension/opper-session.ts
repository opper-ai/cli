/**
 * Opper session extension for `opper launch pi`.
 *
 * Shipped by the Opper CLI into the isolated PI_CODING_AGENT_DIR at launch and
 * auto-discovered by pi. On every session boundary it re-registers the `opper`
 * provider with two headers (same value):
 *
 *   X-Opper-Trace-Id       = uuid5(NS, <pi session>)
 *   X-Opper-Parent-Span-Id = uuid5(NS, <pi session>)
 *
 * The shared value groups a session's calls into one Opper trace, pins the
 * session to one provider for prompt-cache reuse, and — because parent == trace
 * — makes task-api auto-create one `session` root span so the session renders as
 * one tree. Deriving the id from pi's own session file means each pi session (a
 * /new, /resume, /fork, /reset, or a child pi process) gets its OWN session
 * root — mirroring the Hermes provider plugin's per-subagent rotation, instead
 * of lumping a whole launch under one flat id.
 *
 * Why session_start and not a per-request hook: pi's before_provider_request can
 * only rewrite the request body, not headers, so the headers are (re)applied via
 * registerProvider on the session boundary — pi applies provider changes to
 * subsequent requests immediately. A partial { headers } registration REPLACES
 * the provider config and drops the apiKey/baseUrl, so we re-supply them from the
 * env the launcher exports (OPPER_API_KEY / OPPER_BASE_URL); the key never lands
 * in on-disk config.
 */
import { createHash } from "node:crypto";

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
      apiKey: process.env.OPPER_API_KEY,
      baseUrl: process.env.OPPER_BASE_URL,
      headers: {
        "X-Opper-Trace-Id": tid,
        "X-Opper-Parent-Span-Id": tid,
      },
    });
  });
}
