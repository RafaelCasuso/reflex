// The same request as `client.mjs`, written by hand over `node:net`.
//
// Loading `node:http` costs a per-call process about 14 ms on its own (see
// `docs/decision-gateway.md`); `node:net` costs about 1.5 ms. HTTP/1.1 with
// one request per connection is a request line, a few headers and a body,
// and the answer is a status line, headers and a body of the length the
// server declares. That is what the hook client (RFX-043) will do.
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import process from "node:process";

const [socketPath, requestFile] = process.argv.slice(2);
const body = readFileSync(requestFile);

const head =
  `POST /v1/decisions HTTP/1.1\r\n` +
  `host: reflex\r\n` +
  `content-type: application/json\r\n` +
  `content-length: ${body.length}\r\n` +
  `connection: close\r\n\r\n`;

const socket = connect(socketPath);
const chunks = [];
socket.on("connect", () => {
  socket.write(head);
  socket.end(body);
});
socket.on("data", (chunk) => chunks.push(chunk));
socket.on("close", () => {
  const raw = Buffer.concat(chunks);
  const split = raw.indexOf("\r\n\r\n");
  const headers = raw.subarray(0, split).toString("latin1");
  const status = Number(headers.split(" ")[1]);
  const text = raw.subarray(split + 4).toString("utf8");
  let effect;
  try {
    effect = JSON.parse(text).effect;
  } catch {
    effect = undefined;
  }
  process.stdout.write(`${effect ?? status}\n`);
});
socket.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
