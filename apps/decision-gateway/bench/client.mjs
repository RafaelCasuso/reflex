// The smallest possible hook client: one request over the socket, the effect
// on stdout, exit. No REFLEX package is loaded, so what this costs end to end
// is the floor for a Node client (ADR-010), not the adapter's work.
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import process from "node:process";

const [socketPath, requestFile] = process.argv.slice(2);
const body = readFileSync(requestFile, "utf8");

const req = request(
  {
    socketPath,
    method: "POST",
    path: "/v1/decisions",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  },
  (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      text += chunk;
    });
    res.on("end", () => {
      process.stdout.write(`${JSON.parse(text).effect ?? res.statusCode}\n`);
    });
  },
);
req.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
req.end(body);
