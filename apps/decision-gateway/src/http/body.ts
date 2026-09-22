import type { IncomingMessage } from "node:http";

/**
 * Reads a request body up to a limit, and not one byte past it. The limit is
 * checked against `Content-Length` before anything is read, and enforced
 * while reading for a body that lies about its length or sends none.
 */
export type BodyResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "too-large" | "aborted" };

export function declaredLength(request: IncomingMessage): number | undefined {
  const header = request.headers["content-length"];
  if (header === undefined) {
    return undefined;
  }
  const length = Number(header);
  return Number.isInteger(length) && length >= 0 ? length : undefined;
}

export function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const settle = (result: BodyResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    request.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      received += chunk.length;
      if (received > maxBytes) {
        // Not one byte more is kept. The caller answers, then closes.
        request.pause();
        settle({ ok: false, reason: "too-large" });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      settle({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
    });
    request.on("error", () => {
      settle({ ok: false, reason: "aborted" });
    });
    request.on("close", () => {
      settle({ ok: false, reason: "aborted" });
    });
  });
}
