import { Buffer } from "node:buffer";
import { connect } from "node:net";

/**
 * RFX-138, RFX-043 — HTTP/1.1 over the daemon's socket, by hand.
 *
 * The hook runs in a process the host starts per tool call, and loading
 * `node:http` costs that process about 14 ms (ADR-010, `docs/decision-gateway.md`
 * §4). One request per connection is a request line, a few headers and a
 * body; the answer is a status line, headers and a body of the length the
 * daemon declares. That is all this file reads, and it never throws: a
 * daemon that is not there, that hangs or that answers nonsense is a typed
 * result the caller decides about.
 */
export interface SocketRequest {
  readonly socketPath: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface SocketResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  /** The body as JSON, when it is JSON. */
  readonly json: unknown;
}

export type SocketRequestResult =
  | { readonly ok: true; readonly response: SocketResponse }
  | {
      readonly ok: false;
      readonly reason: "unreachable" | "timeout" | "malformed";
    };

const SEPARATOR = "\r\n\r\n";

function parseHead(head: string): {
  status: number;
  headers: Record<string, string>;
} {
  const [statusLine = "", ...rest] = head.split("\r\n");
  const status = Number(statusLine.split(" ")[1]);
  const headers: Record<string, string> = {};
  for (const line of rest) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line
        .slice(colon + 1)
        .trim();
    }
  }
  return { status, headers };
}

export function requestOverSocket(
  request: SocketRequest,
): Promise<SocketRequestResult> {
  return new Promise((resolve) => {
    const body = Buffer.from(request.body ?? "", "utf8");
    const headerLines = Object.entries({
      host: "reflex",
      "content-type": "application/json",
      accept: "application/json",
      ...request.headers,
      "content-length": String(body.length),
      connection: "close",
    })
      .map(([name, value]) => `${name}: ${value}`)
      .join("\r\n");
    const head = `${request.method} ${request.path} HTTP/1.1\r\n${headerLines}\r\n\r\n`;

    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: SocketRequestResult): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };
    const socket = connect(request.socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      finish({ ok: false, reason: "timeout" });
    }, request.timeoutMs);

    socket.on("connect", () => {
      socket.write(head);
      socket.end(body);
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on("error", () => {
      finish({ ok: false, reason: "unreachable" });
    });
    socket.on("close", () => {
      if (settled) {
        return;
      }
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf(SEPARATOR);
      if (split < 0) {
        finish({ ok: false, reason: "malformed" });
        return;
      }
      const { status, headers } = parseHead(
        raw.subarray(0, split).toString("latin1"),
      );
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        finish({ ok: false, reason: "malformed" });
        return;
      }
      const declared = Number(headers["content-length"]);
      let payload = raw.subarray(split + SEPARATOR.length);
      if (Number.isInteger(declared) && declared >= 0) {
        if (payload.length < declared) {
          finish({ ok: false, reason: "malformed" });
          return;
        }
        payload = payload.subarray(0, declared);
      }
      const text = payload.toString("utf8");
      let json: unknown;
      try {
        json = text === "" ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      finish({ ok: true, response: { status, headers, text, json } });
    });
  });
}
