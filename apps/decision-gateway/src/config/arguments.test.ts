import { describe, expect, it } from "vitest";

import { defaultSocketPath, parseArguments } from "./arguments.js";

const env = { REFLEX_HOME: "/home/dev/.reflex" };

describe("the daemon's command line", () => {
  it("listens on the REFLEX home's socket by default, with nothing loaded", () => {
    const parsed = parseArguments([], env);
    expect(parsed).toEqual({
      ok: true,
      arguments: {
        listen: { kind: "socket", path: "/home/dev/.reflex/run/reflex.sock" },
        policyFiles: [],
        failureMode: "fail-ask",
        cache: true,
        reflexHome: "/home/dev/.reflex",
        telemetry: true,
        rateLimit: undefined,
      },
    });
    expect(defaultSocketPath("/x")).toBe("/x/run/reflex.sock");
  });

  it("reads every flag", () => {
    const parsed = parseArguments(
      [
        "--socket",
        "/tmp/r.sock",
        "--policy",
        "a.yaml",
        "--policy",
        "b.yaml",
        "--failure-mode",
        "fail-closed",
        "--no-cache",
        "--no-telemetry",
        "--home",
        "/elsewhere",
        "--rate-limit",
        "50/10.5",
      ],
      env,
    );
    expect(parsed).toEqual({
      ok: true,
      arguments: {
        listen: { kind: "socket", path: "/tmp/r.sock" },
        policyFiles: ["a.yaml", "b.yaml"],
        failureMode: "fail-closed",
        cache: false,
        reflexHome: "/elsewhere",
        telemetry: false,
        rateLimit: { burst: 50, perSecond: 10.5 },
      },
    });
  });

  it("reads a TCP target, IPv6 included", () => {
    expect(parseArguments(["--tcp", "127.0.0.1:0"], env)).toMatchObject({
      ok: true,
      arguments: { listen: { kind: "tcp", host: "127.0.0.1", port: 0 } },
    });
    expect(parseArguments(["--tcp", "::1:8080"], env)).toMatchObject({
      ok: true,
      arguments: { listen: { kind: "tcp", host: "::1", port: 8080 } },
    });
  });

  // A daemon that starts with a misread flag runs with the wrong policy.
  it.each([
    ["an unknown flag", ["--verbose"]],
    ["a flag without its value", ["--socket"]],
    ["an empty value", ["--policy", ""]],
    ["a failure mode that does not exist", ["--failure-mode", "fail-safe"]],
    ["a port that is not one", ["--tcp", "127.0.0.1:http"]],
    ["a TCP target without a host", ["--tcp", ":80"]],
    ["a port out of range", ["--tcp", "127.0.0.1:70000"]],
    ["a rate limit without a rate", ["--rate-limit", "300"]],
    ["a rate limit that lets nothing through", ["--rate-limit", "0/10"]],
  ])("refuses %s", (_label, argv) => {
    const parsed = parseArguments(argv, env);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problem).toContain("usage:");
  });
});
