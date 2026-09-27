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
        semanticProvider: "none",
        semanticModel: undefined,
        semanticEndpoint: undefined,
        shadowProviders: [],
        shadowDeadlineMs: 5_000,
        shadowSample: "unresolved",
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
        "--semantic-provider",
        "jev",
        "--semantic-model",
        "jev-1.13.0",
        "--semantic-endpoint",
        "https://api.example.test/v1/systemone",
        "--shadow-provider",
        "fake",
        "--shadow-provider",
        "local",
        "--shadow-deadline",
        "250",
        "--remote-consent",
        "/elsewhere/consent.json",
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
        semanticProvider: "jev",
        semanticModel: "jev-1.13.0",
        semanticEndpoint: "https://api.example.test/v1/systemone",
        shadowProviders: ["fake", "local"],
        shadowDeadlineMs: 250,
        shadowSample: "unresolved",
        remoteConsentFile: "/elsewhere/consent.json",
      },
    });
  });

  it("refuses --remote-consent without a file (RFX-123)", () => {
    expect(parseArguments(["--remote-consent"], env).ok).toBe(false);
    expect(parseArguments(["--remote-consent", ""], env).ok).toBe(false);
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

describe("RFX-141 the semantic provider flags", () => {
  it.each(["none", "jev", "local", "reflex", "fake"] as const)(
    "accepts %s",
    (id) => {
      expect(parseArguments(["--semantic-provider", id], env)).toMatchObject({
        ok: true,
        arguments: { semanticProvider: id },
      });
    },
  );

  it.each([
    [["--semantic-provider"], "needs none, jev"],
    [["--semantic-provider", "openai"], "needs none, jev"],
    [["--semantic-provider", "JEV"], "needs none, jev"],
    [["--semantic-model"], "needs a versioned model"],
    [
      ["--semantic-provider", "jev", "--semantic-model", ""],
      "needs a versioned model",
    ],
    [["--semantic-endpoint", "api.example.test"], "needs an http or https URL"],
    [
      ["--semantic-provider", "jev", "--semantic-endpoint", "ftp://x"],
      "needs an http or https URL",
    ],
    [["--semantic-model", "jev-1.13.0"], "need a --semantic-provider"],
    [
      ["--semantic-endpoint", "http://127.0.0.1:1"],
      "need a --semantic-provider",
    ],
  ])("refuses %j", (argv, message) => {
    const parsed = parseArguments(argv, env);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problem).toContain(message);
    }
  });
});

describe("RFX-142 the shadow flags", () => {
  it("reads shadows behind a primary, with their sample", () => {
    expect(
      parseArguments(
        [
          "--semantic-provider",
          "jev",
          "--shadow-provider",
          "local",
          "--shadow-sample",
          "all",
        ],
        env,
      ),
    ).toMatchObject({
      ok: true,
      arguments: { shadowProviders: ["local"], shadowSample: "all" },
    });
  });

  it.each([
    [["--shadow-provider", "fake"], "needs a --semantic-provider"],
    [
      ["--semantic-provider", "fake", "--shadow-provider", "none"],
      "needs jev, local",
    ],
    [["--semantic-provider", "fake", "--shadow-provider"], "needs jev, local"],
    [
      [
        "--semantic-provider",
        "fake",
        "--shadow-provider",
        "fake",
        "--shadow-sample",
        "all",
      ],
      "local shadows only",
    ],
    [
      [
        "--semantic-provider",
        "fake",
        "--shadow-provider",
        "local",
        "--shadow-provider",
        "jev",
        "--shadow-sample",
        "all",
      ],
      "local shadows only",
    ],
    [
      ["--semantic-provider", "fake", "--shadow-sample", "sometimes"],
      "needs unresolved or all",
    ],
    [
      ["--semantic-provider", "fake", "--shadow-deadline", "0"],
      "whole milliseconds",
    ],
    [
      ["--semantic-provider", "fake", "--shadow-deadline", "1.5"],
      "whole milliseconds",
    ],
    [
      ["--semantic-provider", "fake", "--shadow-deadline"],
      "whole milliseconds",
    ],
  ])("refuses %j", (argv, message) => {
    const parsed = parseArguments(argv, env);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problem).toContain(message);
    }
  });
});
