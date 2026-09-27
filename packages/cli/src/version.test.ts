import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CLI_VERSION } from "./version.js";

describe("CLI_VERSION", () => {
  it("is the manifest's version", () => {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { version: string };
    expect(CLI_VERSION).toBe(manifest.version);
  });
});
