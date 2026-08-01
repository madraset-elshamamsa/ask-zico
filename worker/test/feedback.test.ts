import { describe, expect, test } from "vitest";
import app from "../src/index";
import type { Env } from "../src/types";

function createFeedbackEnv(overrides: Partial<Env> = {}): Env {
  const inserts: unknown[][] = [];

  return {
    BETA_ACCESS_TOKEN: "secret-token",
    ASSISTANT_FEEDBACK_DB: {
      prepare: (query) => ({
        bind: (...values) => ({
          run: async () => {
            inserts.push([query, values]);
            return { success: true };
          },
          all: async () => ({ success: true, results: [] }),
        }),
      }),
    },
    ...overrides,
  };
}

describe("assistant feedback endpoint", () => {
  test("requires beta token for feedback requests", async () => {
    const response = await app.request(
      "/api/assistant/feedback",
      {
        method: "POST",
        body: JSON.stringify({
          session_id: "session-1",
          message_id: "message-1",
          rating: "up",
          created_at: "2026-06-13T10:00:00.000Z",
        }),
      },
      createFeedbackEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_assistant_token",
    });
  });

  test("rejects invalid feedback payloads", async () => {
    const response = await app.request(
      "/api/assistant/feedback",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-beta-token": "secret-token",
        },
        body: JSON.stringify({
          session_id: "",
          message_id: "message-1",
          rating: "maybe",
          created_at: "not-a-date",
        }),
      },
      createFeedbackEnv(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  test("stores valid feedback in D1", async () => {
    const inserts: unknown[][] = [];
    const response = await app.request(
      "/api/assistant/feedback",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-beta-token": "secret-token",
        },
        body: JSON.stringify({
          session_id: "session-1",
          message_id: "message-1",
          conversation_id: "conversation-1",
          rating: "down",
          confidence: "low",
          doc_ids: ["wa3zat:Doc"],
          chunk_ids: ["wa3zat:Doc:0"],
          citation_urls: ["https://madraset-elshamamsa.com/articles/wa3zat/Doc.php"],
          created_at: "2026-06-13T10:00:00.000Z",
        }),
      },
      createFeedbackEnv({
        ASSISTANT_FEEDBACK_DB: {
          prepare: (query) => ({
            bind: (...values) => ({
              run: async () => {
                inserts.push([query, values]);
                return { success: true };
              },
              all: async () => ({ success: true, results: [] }),
            }),
          }),
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(inserts.length).toBeGreaterThanOrEqual(1);
    expect(inserts[0][0]).toContain("INSERT INTO assistant_feedback");
    expect(inserts[0][1]).toEqual([
      "session-1",
      "message-1",
      "conversation-1",
      "down",
      "low",
      JSON.stringify(["wa3zat:Doc"]),
      JSON.stringify(["wa3zat:Doc:0"]),
      JSON.stringify(["https://madraset-elshamamsa.com/articles/wa3zat/Doc.php"]),
      "2026-06-13T10:00:00.000Z",
    ]);
  });

  test("returns server error when D1 feedback binding is missing", async () => {
    const response = await app.request(
      "/api/assistant/feedback",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-beta-token": "secret-token",
        },
        body: JSON.stringify({
          session_id: "session-1",
          message_id: "message-1",
          rating: "up",
          created_at: "2026-06-13T10:00:00.000Z",
        }),
      },
      createFeedbackEnv({ ASSISTANT_FEEDBACK_DB: undefined }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "feedback_not_configured",
    });
  });
});
