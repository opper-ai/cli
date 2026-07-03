import WebSocket from "ws";

import { resolveApiContext } from "../api/resolve.js";
import { brand } from "../ui/colors.js";
import { OpperError } from "../errors.js";

// ttyd wire protocol (the app's in-pod web terminal). Server→client and
// client→server messages are a single command byte followed by payload.
const OUTPUT = 0x30; // '0' server→client: terminal bytes
const INPUT = "0"; //   client→server: keystrokes
const RESIZE = "1"; //   client→server: {columns, rows}

export interface AppsShellOptions {
  name: string;
  key: string;
}

// appsShellCommand opens an interactive terminal in the running app's
// container. It connects to the app's /run/shell WebSocket (ttyd, proxied
// by the wrapper) through the normal API-key-authed chain — no SSH, no
// cluster access. stdin goes raw so keystrokes (incl. Ctrl-C/Ctrl-D) reach
// the remote shell rather than this process.
export async function appsShellCommand(opts: AppsShellOptions): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const wsURL =
    ctx.baseUrl.replace(/^http/, "ws").replace(/\/+$/, "") +
    `/v3/apps/${encodeURIComponent(opts.name)}/run/shell/ws`;

  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) {
    throw new OpperError(
      "INVALID_ARGUMENT",
      "opper apps shell needs an interactive terminal",
      "Run it directly in your terminal, not through a pipe.",
    );
  }

  const ws = new WebSocket(wsURL, ["tty"], {
    headers: { Authorization: `Bearer ${ctx.apiKey}` },
  });

  let raw = false;
  let restored = false;
  const enterRaw = () => {
    if (!raw) {
      stdin.setRawMode(true);
      raw = true;
    }
  };
  // Undo everything the remote PTY (ttyd + whatever ran in it) may have turned
  // on, so it doesn't persist after we disconnect and clobber the user's shell.
  // setRawMode(false) alone is not enough: the remote enables terminal modes via
  // output bytes we forwarded to stdout — most painfully the kitty keyboard
  // protocol, which then turns every keypress into CSI-u byte soup (";1:3u").
  // These are all "disable" sequences and are no-ops on modes that weren't set.
  const restore = () => {
    if (restored) return;
    restored = true;
    if (raw) {
      stdin.setRawMode(false);
      raw = false;
    }
    if (stdout.isTTY) {
      stdout.write(
        "\x1b[<u" + // pop kitty keyboard protocol flags (the ";1:3u" garble)
          "\x1b[?2004l" + // bracketed paste off
          "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" + // mouse reporting off
          "\x1b[?25h" + // show cursor
          "\x1b>", // normal keypad (DECPNM)
      );
    }
    stdin.pause();
  };
  // Safety net: the .finally() below restores on a normal disconnect, but an
  // abrupt exit (Ctrl-\, SIGTERM, terminal hang-up) would otherwise strand the
  // terminal in the broken mode. restore() is idempotent and sync-safe.
  const onExitSignal = () => {
    restore();
    process.exit(0);
  };
  process.once("exit", restore);
  process.once("SIGINT", onExitSignal);
  process.once("SIGTERM", onExitSignal);
  process.once("SIGHUP", onExitSignal);

  const onStdin = (chunk: Buffer) => {
    // INPUT frame: command byte + raw bytes (binary-safe, so Ctrl chars
    // and UTF-8 survive intact).
    ws.send(Buffer.concat([Buffer.from(INPUT), chunk]));
  };
  const onResize = () => {
    ws.send(
      RESIZE +
        JSON.stringify({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 }),
    );
  };

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      // ttyd init: the first message is the auth/size JSON (no command
      // byte). AuthToken is empty — task-api already authed us.
      ws.send(
        JSON.stringify({
          AuthToken: "",
          columns: stdout.columns ?? 80,
          rows: stdout.rows ?? 24,
        }),
      );
      console.error(
        brand.dim(`connected to ${opts.name} — exit the shell to disconnect`),
      );
      enterRaw();
      stdin.resume();
      stdin.on("data", onStdin);
      stdout.on("resize", onResize);
    });

    ws.on("message", (data: WebSocket.RawData) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);
      // Only OUTPUT carries terminal bytes; title/preference frames are
      // ignored.
      if (buf[0] === OUTPUT) stdout.write(buf.subarray(1));
    });

    ws.on("close", () => resolve());
    ws.on("error", (err: Error) =>
      reject(
        new OpperError(
          "NETWORK_ERROR",
          `shell connection failed: ${err.message}`,
          "Check the app is running (`opper apps get <name>`) and that shells are enabled for it.",
        ),
      ),
    );
  }).finally(() => {
    stdin.off("data", onStdin);
    stdout.off("resize", onResize);
    restore();
  });
}
