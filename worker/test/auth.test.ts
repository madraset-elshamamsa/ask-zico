import { describe, expect, test } from "vitest";
import { assertAssistantAccess } from "../src/auth";

describe("assertAssistantAccess", () => {
  const env = {
    ASSISTANT_PROXY_TOKEN: "proxy-secret",
    ASSISTANT_EVAL_TOKEN: "eval-secret",
    BETA_ACCESS_TOKEN: "legacy-secret",
  };

  test("authenticates the PHP proxy role", () => {
    const request = new Request("https://worker.test/api/assistant/message", {
      headers: { "x-assistant-proxy-token": "proxy-secret" },
    });
    expect(assertAssistantAccess(request, env)).toEqual({ ok: true, role: "proxy" });
  });

  test("authenticates the evaluation role", () => {
    const request = new Request("https://worker.test/api/assistant/message", {
      headers: { "x-assistant-eval-token": "eval-secret" },
    });
    expect(assertAssistantAccess(request, env)).toEqual({ ok: true, role: "eval" });
  });

  test("rejects the retired legacy beta token", () => {
    const request = new Request("https://worker.test/api/assistant/message", {
      headers: { "x-assistant-beta-token": "legacy-secret" },
    });
    expect(assertAssistantAccess(request, env)).toEqual({
      ok: false,
      status: 401,
      error: "invalid_assistant_token",
    });
  });

  test("rejects missing, invalid, or ambiguous caller credentials", () => {
    const missing = new Request("https://worker.test/api/assistant/message");
    const invalid = new Request("https://worker.test/api/assistant/message", {
      headers: { "x-assistant-proxy-token": "wrong" },
    });
    const ambiguous = new Request("https://worker.test/api/assistant/message", {
      headers: {
        "x-assistant-proxy-token": "proxy-secret",
        "x-assistant-eval-token": "eval-secret",
      },
    });
    for (const request of [missing, invalid, ambiguous]) {
      expect(assertAssistantAccess(request, env)).toEqual({
        ok: false,
        status: 401,
        error: "invalid_assistant_token",
      });
    }
  });
});
