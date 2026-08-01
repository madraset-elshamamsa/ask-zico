import { describe, expect, test } from "vitest";
import app from "../src/index";
import type { AssistantMessageResponse, Env, StoredChunk } from "../src/types";

type RecordedQuery = {
  query: string;
  values: unknown[];
};

function createEnv(chunks: StoredChunk[], overrides: Partial<Env> = {}) {
  const rows: Record<string, unknown>[] = [];
  const queries: RecordedQuery[] = [];
  let modelCalls = 0;
  const env: Env & { rows: typeof rows; queries: typeof queries; modelCalls: () => number } = {
    BETA_ACCESS_TOKEN: "secret-token",
    RETRIEVAL_TOP_K: "3",
    ASSISTANT_DEVICE_DAILY_MODEL_LIMIT: "0",
    ASSISTANT_CHUNKS: {
      get: async (key) => {
        if (key === "lexical:wa3zat") {
          return chunks;
        }
        return chunks.find((chunk) => chunk.chunk_id === key) ?? null;
      },
    },
    ASSISTANT_FEEDBACK_DB: {
      prepare: (query) => ({
        bind: (...values) => ({
          run: async () => {
            queries.push({ query, values });
            return { success: true };
          },
          all: async <T = Record<string, unknown>>() => {
            queries.push({ query, values });
            return { success: true, results: rows as T[] };
          },
        }),
      }),
    },
    ASSISTANT_CHAT_MODEL: "test/model",
    ASSISTANT_LLM_API_KEY: "test-key",
    ASSISTANT_LLM_FETCH: async () => {
      modelCalls += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answer: "Supported answer.",
                  confidence: "high",
                  cited_chunk_ids: ["wa3zat:InternalPath:0"],
                }),
              },
            },
          ],
        }),
      );
    },
    rows,
    queries,
    modelCalls: () => modelCalls,
    ...overrides,
  };
  return env;
}

const chunk: StoredChunk = {
  doc_id: "wa3zat:InternalPath",
  chunk_id: "wa3zat:InternalPath:0",
  title: "Internal Path",
  url: "https://madraset-elshamamsa.com/articles/wa3zat/InternalPath.php",
  text: "The internal path starts in the heart.",
  search_text: "internal path heart",
  content_type: "article",
  library: "Wa3zat",
  section: "Content",
  language: "en",
};

describe("assistant worker economics gate", () => {
  test("returns source fallback without calling the model when device quota is exhausted", async () => {
    const env = createEnv([chunk]);
    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-beta-token": "secret-token",
        },
        body: JSON.stringify({
          assistant_device_id: "device-1",
          session_id: "session-1",
          message: "internal path",
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as AssistantMessageResponse;
    expect(env.modelCalls()).toBe(0);
    expect(body.answer).toContain("وصلت للحد اليومي");
    expect(body.citations).toHaveLength(0);
    expect(body.suggested_actions.some((action) => action.url.endsWith("/search.php"))).toBe(true);
    expect(body.debug?.answer).toEqual({
      mode: "fallback",
      reason: "device_daily_quota",
    });
  });

  test("can keep source-card fallback when configured", async () => {
    const env = createEnv([chunk], {
      ASSISTANT_QUOTA_FALLBACK_MODE: "sources_with_search",
    });
    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-beta-token": "secret-token",
        },
        body: JSON.stringify({
          assistant_device_id: "device-1",
          session_id: "session-1",
          message: "internal path",
        }),
      },
      env,
    );

    const body = (await response.json()) as AssistantMessageResponse;
    expect(body.citations).toHaveLength(1);
    expect(body.suggested_actions.some((action) => action.url.includes("InternalPath.php"))).toBe(true);
  });

  test("quota status reports blocked state without retrieval or model call", async () => {
    const env = createEnv([chunk], {
      ASSISTANT_DEVICE_DAILY_MODEL_LIMIT: "0",
      ASSISTANT_GLOBAL_DAILY_MODEL_LIMIT: "650",
    });
    const response = await app.request(
      "/api/assistant/quota-status",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-beta-token": "secret-token",
        },
        body: JSON.stringify({
          assistant_device_id: "device-1",
          session_id: "session-1",
        }),
      },
      env,
    );

    const body = await response.json() as { assistant_available: boolean; fallback_reason?: string; quota?: unknown; suggested_actions?: Array<{ url: string }> };
    expect(response.status).toBe(200);
    expect(env.modelCalls()).toBe(0);
    expect(body.assistant_available).toBe(false);
    expect(body.fallback_reason).toBe("device_daily_quota");
    expect(body.quota).toMatchObject({
      block_reason: "device_daily_quota",
      device_daily: { used: 0, limit: 0, remaining: 0 },
    });
    expect(body.suggested_actions?.some((action) => action.url.endsWith("/search.php"))).toBe(true);
    expect(body.suggested_actions?.some((action) => action.url.includes("#categoriesSection"))).toBe(true);
  });

  test("includes quota metadata on fallback responses", async () => {
    const env = createEnv([chunk], {
      ASSISTANT_DEVICE_DAILY_MODEL_LIMIT: "0",
      ASSISTANT_GLOBAL_DAILY_MODEL_LIMIT: "650",
    });
    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-beta-token": "secret-token",
        },
        body: JSON.stringify({
          assistant_device_id: "device-1",
          session_id: "session-1",
          message: "internal path",
        }),
      },
      env,
    );

    const body = (await response.json()) as AssistantMessageResponse;
    expect(body.quota).toMatchObject({
      block_reason: "device_daily_quota",
      device_daily: {
        used: 0,
        limit: 0,
        remaining: 0,
      },
      global_daily: {
        limit: 650,
      },
    });
  });


  test("consumes quota for handled no-answer responses after the gate", async () => {
    const env = createEnv([{ ...chunk, text: "short" }], {
      ASSISTANT_DEVICE_DAILY_MODEL_LIMIT: "1",
      ASSISTANT_GLOBAL_DAILY_MODEL_LIMIT: "650",
    });

    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-beta-token": "secret-token",
        },
        body: JSON.stringify({
          assistant_device_id: "device-1",
          session_id: "session-1",
          message: "internal path",
        }),
      },
      env,
    );

    const body = (await response.json()) as AssistantMessageResponse;
    expect(response.status).toBe(200);
    expect(env.modelCalls()).toBe(0);
    expect(body.debug?.answer).toMatchObject({
      mode: "handoff",
      reason: "weak_retrieval",
    });
    expect(body.quota).toMatchObject({
      device_daily: { used: 1, limit: 1, remaining: 0 },
      global_daily: { limit: 650, remaining: 649 },
    });
    const usageInsert = env.queries.find((item) => item.query.includes("INSERT INTO assistant_usage_counters"));
    expect(usageInsert?.values[5]).toBe(1);
  });

  test("fallback-only mode skips the model but still returns retrieved sources", async () => {
    const env = createEnv([{ ...chunk, text: "The internal path starts in the heart and continues through repentance with God." }], {
      ASSISTANT_DEVICE_DAILY_MODEL_LIMIT: undefined,
      ASSISTANT_FALLBACK_ONLY_MODE: "true",
    });
    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-beta-token": "secret-token",
        },
        body: JSON.stringify({
          assistant_device_id: "device-1",
          message: "internal path",
        }),
      },
      env,
    );

    const body = (await response.json()) as AssistantMessageResponse;
    expect(response.status).toBe(200);
    expect(env.modelCalls()).toBe(0);
    expect(body.debug?.answer).toEqual({
      mode: "fallback",
      reason: "fallback_only_mode",
    });
  });


  test("records zero estimated spend for direct Gemini answers", async () => {
    const env = createEnv([{ ...chunk, text: "The internal path starts in the heart and continues through repentance with God." }], {
      ASSISTANT_DEVICE_DAILY_MODEL_LIMIT: undefined,
      ASSISTANT_LLM_API_KEY: "openrouter-key",
      ASSISTANT_GEMINI_API_KEY: "gemini-key",
      ASSISTANT_GEMINI_MODEL: "gemini-2.5-flash-lite",
      ASSISTANT_ESTIMATED_MODEL_COST_USD: "0.001",
      ASSISTANT_LLM_FETCH: async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        status: "ANSWERED",
                        answer: "Supported answer.",
                        confidence: "high",
                        cited_chunk_ids: ["wa3zat:InternalPath:0"],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });

    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-beta-token": "secret-token",
        },
        body: JSON.stringify({
          assistant_device_id: "device-1",
          session_id: "session-1",
          message: "internal path",
        }),
      },
      env,
    );

    const body = (await response.json()) as AssistantMessageResponse;
    const usageInsert = env.queries.find((item) => item.query.includes("INSERT INTO assistant_usage_counters"));
    expect(response.status).toBe(200);
    expect(body.debug?.answer).toMatchObject({
      mode: "grounded",
      model_provider: "gemini",
      estimated_model_cost_usd: 0,
    });
    expect(usageInsert?.values[12]).toBe(0);
  });
  test("invalid requests do not write usage counters", async () => {
    const env = createEnv([{ ...chunk, text: "The internal path starts in the heart and continues through repentance with God." }], {
      ASSISTANT_DEVICE_DAILY_MODEL_LIMIT: "1",
    });
    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-beta-token": "secret-token",
        },
        body: JSON.stringify({ message: "" }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(env.queries.some((item) => item.query.includes("assistant_usage_counters"))).toBe(false);
  });
});
