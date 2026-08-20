import { describe, expect, test } from "vitest";
import app from "../src/index";
import type { AssistantMessageResponse, Env, StoredChunk } from "../src/types";

const arabicChunk: StoredChunk = {
  doc_id: "wa3zat:inner-path",
  chunk_id: "wa3zat:inner-path:0",
  title: "الطريق الداخلي",
  url: "https://madraset-elshamamsa.com/articles/wa3zat/inner-path.php",
  text: "الطريق الداخلي يبدأ من القلب ومن مراجعة الإنسان لنفسه أمام الله.",
  search_text: "الطريق الداخلي يبدأ من القلب مراجعة النفس",
  content_type: "article",
  library: "وعظات",
  language: "ar",
};

function env(overrides: Partial<Env> = {}): Env {
  return {
    ASSISTANT_PROXY_TOKEN: "proxy-token",
    ASSISTANT_EVAL_TOKEN: "eval-token",
    RETRIEVAL_TOP_K: "3",
    ASSISTANT_ACTOR_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ASSISTANT_NETWORK_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ASSISTANT_CHUNKS: {
      get: async (key) => key === "lexical:wa3zat" ? [arabicChunk] : key === arabicChunk.chunk_id ? arabicChunk : null,
    },
    ASSISTANT_FEEDBACK_DB: {
      prepare: () => ({
        bind: () => ({
          run: async () => ({ success: true, meta: { changes: 1 } }),
          all: async <T = Record<string, unknown>>() => ({ success: true, results: [] as T[] }),
        }),
      }),
    },
    ...overrides,
  };
}

function post(tokenHeader: string, token: string, payload: Record<string, unknown>, testEnv: Env) {
  const trustedPayload = tokenHeader === "x-assistant-proxy-token"
    ? { actor_id: "test-actor", network_id: "test-network", ...payload }
    : payload;
  return app.request("/api/assistant/message", {
    method: "POST",
    headers: { "content-type": "application/json", [tokenHeader]: token },
    body: JSON.stringify(trustedPayload),
  }, testEnv);
}

describe("multilingual assistant worker", () => {
  function languageFailureEnv(overrides: Partial<Env> = {}) {
    const queries: Array<{ query: string; values: unknown[] }> = [];
    let retrievalCalls = 0;
    const testEnv = env({
      ASSISTANT_CHUNKS: { get: async () => { retrievalCalls += 1; return []; } },
      ASSISTANT_FEEDBACK_DB: {
        prepare: (query) => ({
          bind: (...values) => ({
            run: async () => { queries.push({ query, values }); return { success: true, meta: { changes: 1 } }; },
            all: async <T = Record<string, unknown>>() => ({ success: true, results: [] as T[] }),
          }),
        }),
      },
      ...overrides,
    });
    return { testEnv, queries, retrievalCalls: () => retrievalCalls };
  }

  test("persists unsupported language metadata without retrieval or model calls", async () => {
    let modelCalls = 0;
    const fixture = languageFailureEnv({
      ASSISTANT_LLM_FETCH: async () => { modelCalls += 1; return new Response("unexpected"); },
    });
    const response = await post("x-assistant-proxy-token", "proxy-token", {
      session_id: "unsupported-session",
      locale: "en",
      message: "こんにちは",
    }, fixture.testEnv);
    expect(response.status).toBe(400);
    expect(fixture.retrievalCalls()).toBe(0);
    expect(modelCalls).toBe(0);
    const insert = fixture.queries.find((item) => item.query.includes("INSERT INTO assistant_query_events"));
    expect(insert?.values.slice(8, 13)).toEqual(["en", "unsupported", "ar", "not_needed", 0]);
  });

  test("persists missing translation configuration and exposes evaluator diagnostics", async () => {
    const fixture = languageFailureEnv();
    const response = await post("x-assistant-eval-token", "eval-token", {
      session_id: "missing-config-session",
      locale: "en",
      message: "What is the inner path?",
      retrieval_only: true,
    }, fixture.testEnv);
    const body = await response.json() as { message?: string; detected_language?: string; answer_language?: string; debug?: { translation?: Record<string, unknown> } };
    expect(response.status).toBe(503);
    expect(body.debug?.translation).toMatchObject({ status: "missing_config", latency_ms: expect.any(Number), provider_attempts: [] });
    expect(body).toMatchObject({ detected_language: "en", answer_language: "en" });
    expect(body.message).toContain("Please try again");
    expect(fixture.retrievalCalls()).toBe(0);
    const insert = fixture.queries.find((item) => item.query.includes("INSERT INTO assistant_query_events"));
    expect(insert?.values[11]).toBe("missing_config");
    expect(insert?.values[12]).toEqual(expect.any(Number));
  });

  test("persists failed translation attempts and exposes them only to evaluators", async () => {
    let modelCalls = 0;
    const fixture = languageFailureEnv({
      ASSISTANT_EVAL_GEMINI_API_KEY: "gemini-key",
      ASSISTANT_LLM_FETCH: async () => { modelCalls += 1; return new Response("busy", { status: 503 }); },
    });
    const response = await post("x-assistant-eval-token", "eval-token", {
      session_id: "failed-translation-session",
      locale: "en",
      message: "What is the inner path?",
      retrieval_only: true,
    }, fixture.testEnv);
    const body = await response.json() as { detected_language?: string; answer_language?: string; debug?: { translation?: { status?: string; provider_attempts?: unknown[] } } };
    expect(response.status).toBe(503);
    expect(body.debug?.translation?.status).toBe("failed");
    expect(body.debug?.translation?.provider_attempts).toHaveLength(1);
    expect(body).toMatchObject({ detected_language: "en", answer_language: "en" });
    expect(modelCalls).toBe(1);
    expect(fixture.retrievalCalls()).toBe(0);
    const insert = fixture.queries.find((item) => item.query.includes("INSERT INTO assistant_query_events"));
    expect(insert?.values[11]).toBe("failed");
    expect(String(insert?.values.find((value) => typeof value === "string" && value.includes('"operation":"translation"')))).toContain("gemini");
  });
  test("short-circuits unsupported messages before retrieval or model calls", async () => {
    let retrievalCalls = 0;
    let modelCalls = 0;
    const response = await post("x-assistant-proxy-token", "proxy-token", { message: "こんにちは" }, env({
      ASSISTANT_CHUNKS: { get: async () => { retrievalCalls += 1; return []; } },
      ASSISTANT_LLM_FETCH: async () => { modelCalls += 1; return new Response("unexpected"); },
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "unsupported_language",
      detected_language: "unsupported",
      answer_language: "ar",
    });
    expect(retrievalCalls).toBe(0);
    expect(modelCalls).toBe(0);
  });

  test("persists unsupported debug retrieval attempts without quota, retrieval, or model calls", async () => {
    let modelCalls = 0;
    const fixture = languageFailureEnv({
      ASSISTANT_LLM_FETCH: async () => { modelCalls += 1; return new Response("unexpected"); },
    });
    const response = await app.request("/debug/retrieval", {
      method: "POST",
      headers: { "content-type": "application/json", "x-assistant-eval-token": "eval-token" },
      body: JSON.stringify({ session_id: "unsupported-debug", message: "こんにちは" }),
    }, fixture.testEnv);
    expect(response.status).toBe(400);
    expect(fixture.retrievalCalls()).toBe(0);
    expect(modelCalls).toBe(0);
    expect(fixture.queries.some((item) => item.query.includes("INSERT INTO assistant_query_events"))).toBe(true);
  });

  test("stops English requests safely when translation config is missing", async () => {
    let retrievalCalls = 0;
    const response = await post("x-assistant-proxy-token", "proxy-token", { message: "What is the inner path?" }, env({
      ASSISTANT_CHUNKS: { get: async () => { retrievalCalls += 1; return []; } },
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "translation_unavailable",
      detected_language: "en",
      answer_language: "en",
      message: expect.stringContaining("Please try again"),
    });
    expect(retrievalCalls).toBe(0);
  });

  test("translates English before evaluator retrieval and exposes translation debug", async () => {
    const fixture = languageFailureEnv({
      ASSISTANT_EVAL_GEMINI_API_KEY: "gemini-key",
      ASSISTANT_CHUNKS: {
        get: async (key) => key === "lexical:wa3zat" ? [arabicChunk] : key === arabicChunk.chunk_id ? arabicChunk : null,
      },
      ASSISTANT_LLM_FETCH: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ما هو الطريق الداخلي؟" }] } }] })),
    });
    const response = await post("x-assistant-eval-token", "eval-token", {
      message: "What is the inner path?", retrieval_only: true, debug: true,
    }, fixture.testEnv);
    const body = await response.json() as AssistantMessageResponse;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ detected_language: "en", answer_language: "en" });
    expect(body.debug?.normalized_query).toBe("ما هو الطريق الداخلي");
    expect(body.debug?.translation).toMatchObject({ status: "translated", provider: "gemini", retrieval_query: "ما هو الطريق الداخلي؟" });
    expect(body.retrieved_chunks[0]?.title).toBe("الطريق الداخلي");
  });

  test("reserves evaluator quota before translation and records retrieval-only observability and usage", async () => {
    const fixture = languageFailureEnv();
    let quotaReservedBeforeTranslation = false;
    fixture.testEnv.ASSISTANT_EVAL_GEMINI_API_KEY = "gemini-key";
    fixture.testEnv.ASSISTANT_LLM_FETCH = async () => {
      quotaReservedBeforeTranslation = fixture.queries.some((item) => item.query.includes("quota_attempts"));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ما هو الطريق الداخلي؟" }] } }] }));
    };
    const response = await post("x-assistant-eval-token", "eval-token", {
      session_id: "metered-eval-session",
      message: "What is the inner path?",
      retrieval_only: true,
      debug: true,
    }, fixture.testEnv);
    expect(response.status).toBe(200);
    expect(quotaReservedBeforeTranslation).toBe(true);
    expect(fixture.queries.some((item) => item.query.includes("INSERT INTO assistant_query_events"))).toBe(true);
    expect(fixture.queries.filter((item) => item.query.includes("INSERT INTO assistant_usage_counters")).length).toBeGreaterThan(1);
  });

  test("blocks exhausted evaluator retrieval quota before translation", async () => {
    let modelCalls = 0;
    const fixture = languageFailureEnv({
      ASSISTANT_EVAL_DAILY_MODEL_LIMIT: "0",
      ASSISTANT_EVAL_GEMINI_API_KEY: "gemini-key",
      ASSISTANT_LLM_FETCH: async () => { modelCalls += 1; return new Response("unexpected"); },
    });
    fixture.testEnv.ASSISTANT_FEEDBACK_DB = {
      prepare: (query) => ({ bind: (...values) => ({
        run: async () => { fixture.queries.push({ query, values }); return { success: true, meta: { changes: 0 } }; },
        all: async <T = Record<string, unknown>>() => ({ success: true, results: [] as T[] }),
      }) }),
    };
    const response = await post("x-assistant-eval-token", "eval-token", {
      message: "What is the inner path?", retrieval_only: true,
    }, fixture.testEnv);
    expect(response.status).toBe(200);
    expect(modelCalls).toBe(0);
    expect((await response.json() as AssistantMessageResponse).debug?.answer).toMatchObject({ mode: "fallback", reason: "evaluation_daily_quota" });
  });

  test("meters and observes debug retrieval while translating substantive English follow-up context", async () => {
    const fixture = languageFailureEnv();
    let prompt = "";
    fixture.testEnv.ASSISTANT_EVAL_GEMINI_API_KEY = "gemini-key";
    fixture.testEnv.ASSISTANT_LLM_FETCH = async (_url, init) => {
      prompt = JSON.stringify(init?.body);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ما هو الطريق الداخلي؟ ممكن مثال؟" }] } }] }));
    };
    const response = await app.request("/debug/retrieval", {
      method: "POST",
      headers: { "content-type": "application/json", "x-assistant-eval-token": "eval-token" },
      body: JSON.stringify({
        session_id: "debug-eval-session",
        message: "ممكن مثال؟",
        follow_up: {
          parent_message_id: "message-1",
          previous_user_message: "What is the inner path?",
          previous_assistant_answer: "الطريق الداخلي يبدأ من القلب.",
          previous_cited_chunk_ids: [],
        },
      }),
    }, fixture.testEnv);
    const body = await response.json() as { normalized_query?: string };
    expect(response.status).toBe(200);
    expect(prompt).toContain("What is the inner path?");
    expect(body.normalized_query).toBe("ما هو الطريق الداخلي ممكن مثال");
    expect(fixture.queries.some((item) => item.query.includes("INSERT INTO assistant_query_events"))).toBe(true);
    expect(fixture.queries.some((item) => item.query.includes("INSERT INTO assistant_usage_counters"))).toBe(true);
  });

  test("translates substantive English from prior follow-up context while answering the Arabic current message", async () => {
    let translationCalls = 0;
    let translationPrompt = "";
    const fixture = languageFailureEnv({
      ASSISTANT_EVAL_GEMINI_API_KEY: "gemini-key",
      ASSISTANT_LLM_FETCH: async (_url, init) => {
        translationCalls += 1;
        translationPrompt = JSON.stringify(init?.body);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ما هو الطريق الداخلي؟ ممكن مثال؟" }] } }] }));
      },
    });
    const response = await post("x-assistant-eval-token", "eval-token", {
      message: "ممكن مثال؟",
      retrieval_only: true,
      follow_up: {
        parent_message_id: "message-1",
        previous_user_message: "What is the inner path?",
        previous_assistant_answer: "الطريق الداخلي يبدأ من القلب.",
        previous_cited_chunk_ids: [],
      },
    }, fixture.testEnv);
    const body = await response.json() as AssistantMessageResponse;
    expect(response.status).toBe(200);
    expect(translationCalls).toBe(1);
    expect(translationPrompt).toContain("What is the inner path?");
    expect(translationPrompt).toContain("ممكن مثال؟");
    expect(body.answer_language).toBe("ar");
    expect(body.debug?.normalized_query).toBe("ما هو الطريق الداخلي ممكن مثال");
  });

  test.each(["Saint Athanasius", "Omonogenis"])(
    "translates compact English follow-up context %s while preserving the Arabic current answer language",
    async (previousUserMessage) => {
      let prompt = "";
      const fixture = languageFailureEnv({
        ASSISTANT_EVAL_GEMINI_API_KEY: "gemini-key",
        ASSISTANT_LLM_FETCH: async (_url, init) => {
          prompt = JSON.stringify(init?.body);
          return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ما معنى القديس أثناسيوس؟" }] } }] }));
        },
      });
      const response = await post("x-assistant-eval-token", "eval-token", {
        message: "ما معناه؟", retrieval_only: true,
        follow_up: { parent_message_id: "message-compact", previous_user_message: previousUserMessage,
          previous_assistant_answer: "إجابة سابقة.", previous_cited_chunk_ids: [] },
      }, fixture.testEnv);
      const body = await response.json() as AssistantMessageResponse;
      expect(response.status).toBe(200);
      expect(prompt).toContain(previousUserMessage);
      expect(body).toMatchObject({ detected_language: "ar", answer_language: "ar" });
      expect(body.debug?.translation).toMatchObject({ status: "translated" });
    },
  );

  test("keeps current Arabic language metadata when compact prior-English translation fails", async () => {
    const fixture = languageFailureEnv({ ASSISTANT_EVAL_GEMINI_API_KEY: "gemini-key",
      ASSISTANT_LLM_FETCH: async () => new Response("busy", { status: 503 }) });
    const response = await post("x-assistant-eval-token", "eval-token", {
      message: "ما معناه؟", retrieval_only: true,
      follow_up: { parent_message_id: "message-compact-failure", previous_user_message: "Saint Athanasius",
        previous_assistant_answer: "إجابة سابقة.", previous_cited_chunk_ids: [] },
    }, fixture.testEnv);
    const body = await response.json() as { message?: string; detected_language?: string; answer_language?: string };
    expect(response.status).toBe(503);
    expect(body).toMatchObject({ detected_language: "ar", answer_language: "ar" });
    expect(body.message).toMatch(/حاول|جرّب/u);
    const insert = fixture.queries.find((item) => item.query.includes("INSERT INTO assistant_query_events"));
    expect(insert?.values.slice(9, 12)).toEqual(["ar", "ar", "failed"]);
  });

  test("applies compact prior-English translation parity to debug retrieval", async () => {
    let prompt = "";
    const fixture = languageFailureEnv({ ASSISTANT_EVAL_GEMINI_API_KEY: "gemini-key",
      ASSISTANT_LLM_FETCH: async (_url, init) => { prompt = JSON.stringify(init?.body);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ما معنى القديس أثناسيوس؟" }] } }] })); } });
    const response = await app.request("/debug/retrieval", { method: "POST",
      headers: { "content-type": "application/json", "x-assistant-eval-token": "eval-token" },
      body: JSON.stringify({ message: "ما معناه؟", follow_up: { parent_message_id: "debug-compact",
        previous_user_message: "Saint Athanasius", previous_assistant_answer: "إجابة سابقة.", previous_cited_chunk_ids: [] } }) }, fixture.testEnv);
    expect(response.status).toBe(200);
    expect(prompt).toContain("Saint Athanasius");
    expect(await response.json()).toMatchObject({ detected_language: "ar", answer_language: "ar" });
  });

  test("rejects compact lowercase Italian prose before retrieval or model calls", async () => {
    let modelCalls = 0;
    const fixture = languageFailureEnv({ ASSISTANT_LLM_FETCH: async () => { modelCalls += 1; return new Response("unexpected"); } });
    const response = await post("x-assistant-proxy-token", "proxy-token", { message: "Dimmi il significato" }, fixture.testEnv);
    expect(response.status).toBe(400);
    expect(modelCalls).toBe(0);
    expect(fixture.retrievalCalls()).toBe(0);
  });

  test("does not translate a mixed Arabic question containing one preserved hymn title", async () => {
    let modelCalls = 0;
    const response = await post("x-assistant-eval-token", "eval-token", {
      message: "إمتى بيتقال Omonogenis؟",
      retrieval_only: true,
    }, env({
      ASSISTANT_LLM_FETCH: async () => {
        modelCalls += 1;
        return new Response("unexpected");
      },
    }));
    expect(response.status).toBe(200);
    expect(modelCalls).toBe(0);
    expect((await response.json() as AssistantMessageResponse).answer_language).toBe("ar");
  });

  test("returns an English grounded answer from Arabic chunks without public translation debug", async () => {
    let calls = 0;
    const response = await post("x-assistant-proxy-token", "proxy-token", { message: "What is the inner path?" }, env({
      ASSISTANT_GEMINI_API_KEY: "gemini-key",
      ASSISTANT_LLM_FETCH: async () => {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ما هو الطريق الداخلي؟" }] } }] }));
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          status: "ANSWERED", answer: "The الطريق الداخلي begins in the heart.", confidence: "high", cited_chunk_ids: [arabicChunk.chunk_id],
        }) }] } }] }));
      },
    }));
    const body = await response.json() as AssistantMessageResponse;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ detected_language: "en", answer_language: "en", answer: "The الطريق الداخلي begins in the heart." });
    expect(body.citations[0]?.title).toBe("الطريق الداخلي");
    expect(body.debug?.translation).toBeUndefined();
    expect(body.debug?.normalized_query).not.toMatch(/\p{Script=Arabic}/u);
  });

  test("returns the English handoff when the answer model repeatedly responds in Arabic", async () => {
    let calls = 0;
    const response = await post("x-assistant-proxy-token", "proxy-token", {
      message: "What is the inner path?",
    }, env({
      ASSISTANT_GEMINI_API_KEY: "gemini-key",
      ASSISTANT_LLM_FETCH: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ما هو الطريق الداخلي؟" }] } }] }));
        }
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          status: "ANSWERED",
          answer: "الطريق الداخلي يبدأ من القلب.",
          confidence: "high",
          cited_chunk_ids: [arabicChunk.chunk_id],
        }) }] } }] }));
      },
    }));
    const body = await response.json() as AssistantMessageResponse;
    expect(response.status).toBe(200);
    expect(calls).toBe(3);
    expect(body.answer_language).toBe("en");
    expect(body.answer).toContain("couldn't find a confirmed answer");
    expect(body.debug?.answer).toMatchObject({ mode: "handoff", reason: "wrong_answer_language" });
  });

  test("checks the public quota gate before spending an English translation call", async () => {
    let modelCalls = 0;
    const response = await post("x-assistant-proxy-token", "proxy-token", {
      message: "What is the inner path?", actor_id: "actor-1", network_id: "network-1",
    }, env({ ASSISTANT_FEEDBACK_DB: undefined, ASSISTANT_GEMINI_API_KEY: "gemini-key", ASSISTANT_LLM_FETCH: async () => { modelCalls += 1; return new Response("unexpected"); } }));
    const body = await response.json() as AssistantMessageResponse;
    expect(response.status).toBe(200);
    expect(modelCalls).toBe(0);
    expect(body).toMatchObject({ detected_language: "en", answer_language: "en" });
    expect(body.answer).toContain("Questions are unavailable");
    expect(body.debug?.translation).toBeUndefined();
  });
});
