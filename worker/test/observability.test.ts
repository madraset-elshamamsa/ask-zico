import { describe, expect, test } from "vitest";
import app from "../src/index";
import { cleanupExpiredAssistantAnswerPreviews, storeAssistantQueryEvent } from "../src/observability";
import type { Env, StoredChunk } from "../src/types";

type RecordedQuery = {
  query: string;
  values: unknown[];
};

type TestEnv = Env & {
  __TEST_RECORDED_QUERIES: RecordedQuery[];
  __TEST_OBSERVABILITY_ROWS: Record<string, unknown>[];
};

function createEnv(chunks: StoredChunk[], overrides: Partial<TestEnv> = {}): TestEnv {
  const rows = overrides.__TEST_OBSERVABILITY_ROWS ?? [];
  const queries: RecordedQuery[] = [];
  const env: TestEnv = {
    ASSISTANT_EVAL_TOKEN: "secret-token",
    ASSISTANT_ADMIN_TOKEN: "admin-token",
    RETRIEVAL_TOP_K: "3",
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
            return { success: true, meta: { changes: 1 } };
          },
          all: async <T = Record<string, unknown>>() => {
            queries.push({ query, values });
            return { success: true, results: rows as T[] };
          },
        }),
      }),
    },
    __TEST_RECORDED_QUERIES: queries,
    __TEST_OBSERVABILITY_ROWS: rows,
    ...overrides,
  };

  return env;
}

const chunk: StoredChunk = {
  doc_id: "wa3zat:ElTariqElDa5ely",
  chunk_id: "wa3zat:ElTariqElDa5ely:0",
  title: "الطريق الداخلي",
  url: "https://madraset-elshamamsa.com/articles/wa3zat/ElTariqElDa5ely.php",
  text: "حل مشاكل الحياة بالنسبة للإنسان يبدأ من الداخل، والطريق الداخلي يبدأ من القلب.",
  search_text: "الطريق الداخلي حل مشاكل الحياة من الداخل القلب",
  content_type: "article",
  library: "عظات",
  section: "الحاجة للدخول إلى الأعماق",
  language: "ar",
  semanticDomain: "ta3lim",
};

describe("assistant observability", () => {
  test("stores language metadata without storing a second translated-query copy", async () => {
    const env = createEnv([]);
    const originalQuery = "What is the inner path?";
    const translatedRetrievalQuery = "ما هو الطريق الداخلي؟";
    const normalizedRetrievalQuery = "ما هو الطريق الداخلي";

    await expect(storeAssistantQueryEvent(env, {
      request: { message: originalQuery, locale: "en", session_id: "session-language" },
      response: {
        message_id: "message-language",
        answer: "The inner path begins in the heart.",
        citations: [],
        suggested_actions: [],
        confidence: "low",
        detected_language: "en",
        answer_language: "en",
        retrieved_chunks: [],
      },
      normalizedQuery: normalizedRetrievalQuery,
      chunks: [],
      startedAt: Date.now(),
      translation: { status: "translated", provider: "gemini", latency_ms: 42 },
    })).resolves.toBe("ok");

    const insert = env.__TEST_RECORDED_QUERIES.find((item) =>
      item.query.includes("INSERT INTO assistant_query_events"),
    );
    expect(insert?.query).toContain("ui_locale, detected_language, answer_language, translation_status, translation_latency_ms");
    expect(insert?.query).not.toContain("retrieval_query");
    expect(insert?.values.slice(7, 15)).toEqual([
      "en", "en", "en", "en", "translated", 42, originalQuery, normalizedRetrievalQuery,
    ]);
    expect(insert?.values).not.toContain(translatedRetrievalQuery);
  });

  test("includes translation provider attempts in existing provider observability", async () => {
    const env = createEnv([]);
    await storeAssistantQueryEvent(env, {
      request: { message: "What is the inner path?", locale: "en" },
      response: {
        message_id: "message-translation-attempt",
        answer: "",
        citations: [],
        suggested_actions: [],
        confidence: "low",
        detected_language: "en",
        answer_language: "ar",
        retrieved_chunks: [],
      },
      normalizedQuery: "",
      chunks: [],
      startedAt: Date.now(),
      translation: {
        status: "failed",
        provider: "openrouter",
        latency_ms: 12,
        provider_attempts: [
          { provider: "gemini", model: "gemini-test", ok: false, reason: "llm_http_error", status: 503, operation: "translation" },
          { provider: "openrouter", model: "router-test", ok: false, reason: "llm_http_error", status: 503, operation: "translation" },
        ],
      },
    });
    const insert = env.__TEST_RECORDED_QUERIES.find((item) => item.query.includes("INSERT INTO assistant_query_events"));
    const attempts = insert?.values.find((value) => typeof value === "string" && value.includes('"operation":"translation"'));
    expect(JSON.parse(String(attempts))).toHaveLength(2);
  });

  test("adds translation cost to grounded-answer cost", async () => {
    const env = createEnv([]);
    await storeAssistantQueryEvent(env, {
      request: { message: "What is the inner path?", locale: "en" },
      response: {
        message_id: "message-combined-cost",
        answer: "The inner path begins in the heart.",
        citations: [],
        suggested_actions: [],
        confidence: "high",
        detected_language: "en",
        answer_language: "en",
        retrieved_chunks: [],
        debug: {
          query: "What is the inner path?",
          normalized_query: "ما هو الطريق الداخلي",
          retrieval_mode: "controlled_hybrid",
          answer: { mode: "grounded", estimated_model_cost_usd: 0.002 },
        },
      },
      normalizedQuery: "ما هو الطريق الداخلي",
      chunks: [],
      startedAt: Date.now(),
      translation: { status: "translated", provider: "gemini", latency_ms: 10, estimated_model_cost_usd: 0.001 },
    });
    const insert = env.__TEST_RECORDED_QUERIES.find((item) => item.query.includes("INSERT INTO assistant_query_events"));
    expect(insert?.values[32]).toBeCloseTo(0.003);
  });

  test("logs grounded message events with query, user, source metadata, and booleans", async () => {
    const env = createEnv([chunk], {
      ASSISTANT_CHAT_MODEL: "test/model",
      ASSISTANT_EVAL_LLM_API_KEY: "test-key",
      ASSISTANT_LLM_FETCH: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer: "حل مشاكل الحياة يبدأ من الداخل بحسب المصدر.",
                    confidence: "high",
                    cited_chunk_ids: ["wa3zat:ElTariqElDa5ely:0"],
                  }),
                },
              },
            ],
          }),
        ),
    });

    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-eval-token": "secret-token",
        },
        body: JSON.stringify({
          session_id: "session-1",
          conversation_id: "conversation-1",
          user_id: "42",
          message: "يعني إيه الطريق الداخلي؟",
          page_context: {
            url: "https://madraset-elshamamsa.com/chatbot/ai-beta.php",
            title: "Chatbot",
          },
          locale: "ar",
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const recorded = env.__TEST_RECORDED_QUERIES ?? [];
    const insert = recorded.find((item) =>
      item.query.includes("INSERT INTO assistant_query_events"),
    );
    expect(insert).toBeDefined();
    expect(insert?.query).toContain("answer_preview");
    expect(insert?.query).toContain("answer_preview_truncated");
    expect(insert?.values).toEqual(
      expect.arrayContaining([
        "session-1",
        "conversation-1",
        "42",
        "يعني إيه الطريق الداخلي؟",
        "https://madraset-elshamamsa.com/chatbot/ai-beta.php",
        "Chatbot",
        "ar",
        1,
        1,
        1,
        "high",
        "grounded",
        null,
        "controlled_hybrid",
        JSON.stringify(["ta3lim"]),
        JSON.stringify(["wa3zat:ElTariqElDa5ely"]),
        JSON.stringify(["wa3zat:ElTariqElDa5ely:0"]),
        JSON.stringify(["https://madraset-elshamamsa.com/articles/wa3zat/ElTariqElDa5ely.php"]),
      ]),
    );
  });

  test("stores model provider, model name, and provider attempts on grounded events", async () => {
    const env = createEnv([chunk], {
      ASSISTANT_CHAT_MODEL: "test/model",
      ASSISTANT_EVAL_LLM_API_KEY: "test-key",
      ASSISTANT_LLM_FETCH: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer: "الطريق الداخلي يبدأ من القلب.",
                    confidence: "high",
                    cited_chunk_ids: ["wa3zat:ElTariqElDa5ely:0"],
                  }),
                },
              },
            ],
          }),
        ),
    });

    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-eval-token": "secret-token",
        },
        body: JSON.stringify({
          session_id: "session-provider",
          message: "الطريق الداخلي",
          normalized_query: chunk.search_text,
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const insert = env.__TEST_RECORDED_QUERIES?.find((item) =>
      item.query.includes("INSERT INTO assistant_query_events"),
    );
    expect(insert?.query).toContain("model_provider");
    expect(insert?.query).toContain("model_name");
    expect(insert?.query).toContain("provider_fallback_reason");
    expect(insert?.query).toContain("provider_attempts_json");
    expect(insert?.values).toEqual(
      expect.arrayContaining([
        "openrouter",
        "test/model",
        null,
        JSON.stringify([{ provider: "openrouter", model: "test/model", ok: true }]),
      ]),
    );
  });
  test("logs unanswered events when retrieval and citations are missing", async () => {
    const env = createEnv([]);
    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-eval-token": "secret-token",
        },
        body: JSON.stringify({
          session_id: "session-2",
          message: "سؤال مش موجود في المصادر",
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const insert = env.__TEST_RECORDED_QUERIES?.find((item) =>
      item.query.includes("INSERT INTO assistant_query_events"),
    );
    expect(insert?.values).toEqual(
      expect.arrayContaining([
        "session-2",
        null,
        null,
        "سؤال مش موجود في المصادر",
        null,
        null,
        null,
        0,
        0,
        0,
        "low",
        "handoff",
        "weak_retrieval",
        "controlled_hybrid",
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify([]),
      ]),
    );
  });

  test("logs one-turn follow-up metadata on query events", async () => {
    const env = createEnv([
      {
        doc_id: "wa3zat:InternalPath",
        chunk_id: "wa3zat:InternalPath:0",
        title: "الطريق الداخلي",
        url: "https://madraset-elshamamsa.com/articles/wa3zat/InternalPath.php",
        text: "يبدأ الطريق الداخلي عندما يفحص الإنسان قلبه قبل أن يلوم الظروف.",
        search_text: "الطريق الداخلي القلب مثال",
        content_type: "article",
        library: "عظات",
        section: "مثال",
        language: "ar",
      },
    ], {
      ASSISTANT_CHAT_MODEL: "test/model",
      ASSISTANT_EVAL_LLM_API_KEY: "test-key",
      ASSISTANT_LLM_FETCH: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer: "مثال بسيط هو فحص القلب قبل لوم الظروف.",
                    confidence: "high",
                    cited_chunk_ids: ["wa3zat:InternalPath:0"],
                  }),
                },
              },
            ],
          }),
        ),
    });

    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-eval-token": "secret-token",
        },
        body: JSON.stringify({
          session_id: "session-follow-up",
          conversation_id: "conversation-1",
          message: "ممكن تديني مثال؟",
          follow_up: {
            parent_message_id: "message-parent",
            previous_user_message: "ما هو الطريق الداخلي؟",
            previous_assistant_answer: "الطريق الداخلي يبدأ من القلب.",
            previous_cited_chunk_ids: ["wa3zat:InternalPath:0"],
          },
          locale: "ar",
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const insert = env.__TEST_RECORDED_QUERIES?.find((item) =>
      item.query.includes("INSERT INTO assistant_query_events"),
    );
    expect(insert?.query).toContain("is_follow_up");
    expect(insert?.values).toEqual(expect.arrayContaining([
      1,
      "message-parent",
      JSON.stringify(["wa3zat:InternalPath:0"]),
    ]));
  });

  test("mirrors feedback rating onto the matching query event", async () => {
    const env = createEnv([]);
    const response = await app.request(
      "/api/assistant/feedback",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-eval-token": "secret-token",
        },
        body: JSON.stringify({
          session_id: "session-1",
          message_id: "message-1",
          rating: "down",
          created_at: "2026-06-20T10:00:00.000Z",
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(env.__TEST_RECORDED_QUERIES?.some((item) =>
      item.query.includes("UPDATE assistant_query_events") &&
      item.values.includes("down") &&
      item.values.includes("message-1"),
    )).toBe(true);
  });

  test("protects observability summary with an admin token", async () => {
    const response = await app.request(
      "/api/assistant/observability/summary",
      {
        method: "GET",
      },
      createEnv([]),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_admin_token" });
  });

  test("returns observability summary aggregates", async () => {
    const env = createEnv([], {
      __TEST_OBSERVABILITY_ROWS: [
        {
          total_queries: 3,
          answered_queries: 2,
          retrieved_references: 2,
          cited_references: 1,
          likes: 1,
          dislikes: 1,
          neutral: 1,
        },
      ],
    });
    const response = await app.request(
      "/api/assistant/observability/summary?range=7d",
      {
        method: "GET",
        headers: {
          "x-assistant-admin-token": "admin-token",
        },
      },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      range: "7d",
      totals: {
        total_queries: 3,
        answered_queries: 2,
        retrieved_references: 2,
        cited_references: 1,
        likes: 1,
        dislikes: 1,
        neutral: 1,
      },
    });
  });

  test("filters observability events by topic, unanswered state, and thumbs down", async () => {
    const env = createEnv([], {
      __TEST_OBSERVABILITY_ROWS: [{ total_queries: 1, answered_queries: 0, retrieved_references: 0, cited_references: 0, likes: 0, dislikes: 1, neutral: 0 }],
    });

    const response = await app.request(
      "/api/assistant/observability/summary?range=30d&topic=ta3lim&answer_state=unanswered&feedback=down",
      { method: "GET", headers: { "x-assistant-admin-token": "admin-token" } },
      env,
    );

    expect(response.status).toBe(200);
    const summaryQuery = env.__TEST_RECORDED_QUERIES?.find((item) => item.query.includes("COUNT(*) AS total_queries"));
    expect(summaryQuery?.query).toContain("answered = 0");
    expect(summaryQuery?.query).toContain("rating = ?");
    expect(summaryQuery?.query).toContain("semantic_domains_json LIKE ?");
    expect(summaryQuery?.values).toEqual(expect.arrayContaining(["down", "%ta3lim%"]));
    await expect(response.json()).resolves.toMatchObject({
      filters: { topic: "ta3lim", answer_state: "unanswered", feedback: "down" },
    });
  });

  test("clears only answer previews older than the retention cutoff", async () => {
    const env = createEnv([]);
    await cleanupExpiredAssistantAnswerPreviews(env, new Date("2026-07-24T00:00:00.000Z"));

    const cleanup = env.__TEST_RECORDED_QUERIES?.find((item) => item.query.includes("SET answer_preview = NULL"));
    expect(cleanup?.query).toContain("answer_preview_truncated = 0");
    expect(cleanup?.query).toContain("created_at < ?");
    expect(cleanup?.values).toEqual(["2026-04-25T00:00:00.000Z"]);
  });
  test("logs worker CPU budget fields on query events", async () => {
    const env = createEnv([chunk], {
      ASSISTANT_CHAT_MODEL: "test/model",
      ASSISTANT_EVAL_LLM_API_KEY: "test-key",
      ASSISTANT_LLM_FETCH: async () =>
        new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            answer: "إجابة مدعومة.",
            confidence: "high",
            cited_chunk_ids: ["wa3zat:ElTariqElDa5ely:0"],
          }) } }],
        })),
    });

    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-eval-token": "secret-token",
        },
        body: JSON.stringify({
          session_id: "session-cpu",
          message: "الطريق الداخلي",
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const insert = env.__TEST_RECORDED_QUERIES?.find((item) =>
      item.query.includes("INSERT INTO assistant_query_events"),
    );
    expect(insert?.query).toContain("worker_cpu_ms");
    expect(insert?.query).toContain("worker_cpu_over_budget");
    expect(insert?.query).toContain("worker_cpu_phases_json");
    expect(insert?.values.some((value) => typeof value === "number" && value >= 0)).toBe(true);
    expect(insert?.values.some((value) => value === 0 || value === 1)).toBe(true);
    expect(insert?.values.some((value) => typeof value === "string" && value.includes("response_build"))).toBe(true);
  });

});
