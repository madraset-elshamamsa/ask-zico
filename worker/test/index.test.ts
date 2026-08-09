import { describe, expect, test } from "vitest";
import app from "../src/index";
import type { AssistantMessageResponse, Env, StoredChunk } from "../src/types";

function createEnv(chunks: StoredChunk[], overrides: Partial<Env> = {}): Env {
  return {
    ASSISTANT_EVAL_TOKEN: "secret-token",
    RETRIEVAL_TOP_K: "3",
    ASSISTANT_FEEDBACK_DB: {
      prepare: () => ({
        bind: () => ({
          run: async () => ({ success: true, meta: { changes: 1 } }),
          all: async () => ({ success: true, results: [] }),
        }),
      }),
    },
    ASSISTANT_CHUNKS: {
      get: async (key) => {
        if (key === "lexical:wa3zat") {
          return chunks;
        }

        return chunks.find((chunk) => chunk.chunk_id === key) ?? null;
      },
    },
    ...overrides,
  };
}

describe("assistant worker", () => {
  test("returns health status", async () => {
    const response = await app.request("/health", {}, createEnv([]));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ask-zico-contract-version")).toBe("1.0.0");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "ask-zico",
      contract_version: "1.0.0",
    });
  });

  test("requires beta token for message requests", async () => {
    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        body: JSON.stringify({ message: "سلام" }),
      },
      createEnv([]),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_assistant_token",
    });
  });

  test("validates message request JSON", async () => {
    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-eval-token": "secret-token",
        },
        body: JSON.stringify({ message: "" }),
      },
      createEnv([]),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  test("returns a grounded answer with citations in the final response shape", async () => {
    const llmCalls: Record<string, unknown>[] = [];
    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-eval-token": "secret-token",
        },
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "إيه معنى الطريق الداخلي؟",
          locale: "ar",
          debug: true,
        }),
      },
      createEnv([
        {
          doc_id: "wa3zat:ElTariqElDa5ely",
          chunk_id: "wa3zat:ElTariqElDa5ely:0",
          title: "الطريق الداخلي",
          url: "https://madraset-elshamamsa.com/articles/wa3zat/ElTariqElDa5ely.php",
          text: "حلّ مشاكل الحياة بالنسبة للإنسان بيكون من الداخل.",
          search_text: "حل مشاكل الحياه بالنسبه للانسان بيكون من الداخل الطريق الداخلي",
          score: 0,
          content_type: "article",
          library: "وعظات",
          section: "الحاجة للدخول إلى الأعماق",
          language: "ar",
        },
      ], {
        ASSISTANT_CHAT_MODEL: "test/model",
        ASSISTANT_EVAL_LLM_API_KEY: "test-key",
        ASSISTANT_LLM_FETCH: async (_url, init) => {
          llmCalls.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      answer: "حلّ مشاكل الحياة بيبدأ من الداخل بحسب المصدر.",
                      confidence: "high",
                      cited_chunk_ids: ["wa3zat:ElTariqElDa5ely:0"],
                    }),
                  },
                },
              ],
            }),
          );
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as AssistantMessageResponse;
    expect(body.answer).toBe("حلّ مشاكل الحياة بيبدأ من الداخل بحسب المصدر.");
    expect(body.confidence).toBe("high");
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0].snippet).toContain("حلّ مشاكل الحياة");
    expect(body.suggested_actions).toEqual([
      {
        type: "navigate_to_url",
        label: "الطريق الداخلي",
        url: "https://madraset-elshamamsa.com/articles/wa3zat/ElTariqElDa5ely.php",
      },
    ]);
    expect(body.retrieved_chunks[0].text).toContain("حلّ مشاكل الحياة");
    expect(body.retrieved_chunks[0]).not.toHaveProperty("search_text");
    expect(body.debug?.normalized_query).toBe("ايه معني الطريق الداخلي");
    expect(body.debug?.retrieval_mode).toBe("controlled_hybrid");
    expect(body.debug?.answer).toMatchObject({
      mode: "grounded",
    });
    expect(JSON.stringify(llmCalls[0])).toContain("حلّ مشاكل الحياة");
    expect(JSON.stringify(llmCalls[0])).not.toContain("search_text");
  });

  test("uses selected previous answer context for one-turn follow-up requests", async () => {
    const llmCalls: Record<string, unknown>[] = [];
    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-eval-token": "secret-token",
        },
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "طب ينفع مثال؟",
          follow_up: {
            parent_message_id: "message-1",
            previous_user_message: "يعني إيه الطريق الداخلي؟",
            previous_assistant_answer: "الطريق الداخلي هو بداية حل المشكلة من القلب.",
            previous_cited_chunk_ids: ["wa3zat:ElTariqElDa5ely:0"],
          },
          locale: "ar",
        }),
      },
      createEnv([
        {
          doc_id: "wa3zat:ElTariqElDa5ely",
          chunk_id: "wa3zat:ElTariqElDa5ely:0",
          title: "الطريق الداخلي",
          url: "https://madraset-elshamamsa.com/articles/wa3zat/ElTariqElDa5ely.php",
          text: "حل مشاكل الحياة بالنسبة للإنسان بيكون من الداخل، والطريق الداخلي يبدأ من القلب.",
          search_text: "الطريق الداخلي حل مشاكل الحياه من الداخل القلب",
          content_type: "article",
          library: "وعظات",
          section: "الحاجة للدخول إلى الأعماق",
          language: "ar",
        },
        {
          doc_id: "wa3zat:Example",
          chunk_id: "wa3zat:Example:0",
          title: "مثال توضيحي",
          url: "https://madraset-elshamamsa.com/articles/wa3zat/Example.php",
          text: "هذا نص عام يحتوي على كلمة مثال لكنه لا يشرح الطريق الداخلي.",
          search_text: "مثال توضيحي",
          content_type: "article",
          library: "وعظات",
          section: "أمثلة",
          language: "ar",
        },
      ], {
        ASSISTANT_CHAT_MODEL: "test/model",
        ASSISTANT_EVAL_LLM_API_KEY: "test-key",
        ASSISTANT_LLM_FETCH: async (_url, init) => {
          llmCalls.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      answer: "مثال بسيط: بدل ما ألوم الظروف، أراجع قلبي وتصرفي الأول.",
                      confidence: "high",
                      cited_chunk_ids: ["wa3zat:ElTariqElDa5ely:0"],
                    }),
                  },
                },
              ],
            }),
          );
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as AssistantMessageResponse;
    expect(body.confidence).toBe("high");
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0].title).toBe("الطريق الداخلي");
    const userMessage = JSON.stringify(llmCalls[0]);
    expect(userMessage).toContain("follow_up");
    expect(userMessage).toContain("يعني إيه الطريق الداخلي؟");
    expect(userMessage).toContain("الطريق الداخلي هو بداية حل المشكلة من القلب.");
  });

  test("returns retrieval-only response without calling the LLM", async () => {
    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-eval-token": "secret-token",
        },
        body: JSON.stringify({
          conversation_id: "retrieval-eval-1",
          message: "internal path",
          retrieval_only: true,
        }),
      },
      createEnv([
        {
          doc_id: "wa3zat:ElTariqElDa5ely",
          chunk_id: "wa3zat:ElTariqElDa5ely:0",
          title: "Internal Path",
          url: "https://madraset-elshamamsa.com/articles/wa3zat/ElTariqElDa5ely.php",
          text: "The internal path starts in the heart.",
          search_text: "internal path heart",
          content_type: "article",
          library: "Wa3zat",
          section: "Content",
          language: "en",
        },
      ]),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as AssistantMessageResponse;
    expect(body.conversation_id).toBe("retrieval-eval-1");
    expect(body.answer).toBe("");
    expect(body.confidence).toBe("retrieval_only");
    expect(body.retrieved_chunks).toHaveLength(1);
    expect(body.debug?.answer).toBeUndefined();
  });

  test("returns answer debug reason when model citation validation fails", async () => {
    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-eval-token": "secret-token",
        },
        body: JSON.stringify({
          message: "إيه معنى الطريق الداخلي؟",
          locale: "ar",
          debug: true,
        }),
      },
      createEnv([
        {
          doc_id: "wa3zat:ElTariqElDa5ely",
          chunk_id: "wa3zat:ElTariqElDa5ely:0",
          title: "الطريق الداخلي",
          url: "https://madraset-elshamamsa.com/articles/wa3zat/ElTariqElDa5ely.php",
          text: "حلّ مشاكل الحياة بالنسبة للإنسان بيكون من الداخل، والطريق الداخلي يبدأ من القلب.",
          search_text: "الطريق الداخلي حل مشاكل الحياه من الداخل القلب",
          content_type: "article",
          library: "وعظات",
          section: "الحاجة للدخول إلى الأعماق",
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
                      answer: "إجابة بدون citation صحيح.",
                      confidence: "medium",
                      cited_chunk_ids: ["wrong"],
                    }),
                  },
                },
              ],
            }),
          ),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as AssistantMessageResponse;
    expect(body.confidence).toBe("low");
    expect(body.citations).toEqual([
      {
        title: "الطريق الداخلي",
        url: "https://madraset-elshamamsa.com/articles/wa3zat/ElTariqElDa5ely.php",
        snippet: "حلّ مشاكل الحياة بالنسبة للإنسان بيكون من الداخل، والطريق الداخلي يبدأ من القلب.",
      },
    ]);
    expect(body.suggested_actions).toEqual([
      {
        type: "navigate_to_url",
        label: "الطريق الداخلي",
        url: "https://madraset-elshamamsa.com/articles/wa3zat/ElTariqElDa5ely.php",
      },
    ]);
    expect(body.debug?.answer).toEqual({
      mode: "handoff",
      reason: "no_valid_citations",
    });
  });

  test("returns protected retrieval debug counts", async () => {
    const response = await app.request(
      "/debug/retrieval",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-eval-token": "secret-token",
        },
        body: JSON.stringify({
          message: "إيه معنى الطريق الداخلي؟",
        }),
      },
      createEnv([
        {
          doc_id: "wa3zat:ElTariqElDa5ely",
          chunk_id: "wa3zat:ElTariqElDa5ely:0",
          title: "الطريق الداخلي",
          url: "https://madraset-elshamamsa.com/articles/wa3zat/ElTariqElDa5ely.php",
          text: "حلّ مشاكل الحياة بالنسبة للإنسان بيكون من الداخل.",
          search_text: "حل مشاكل الحياه بالنسبه للانسان بيكون من الداخل الطريق الداخلي",
          content_type: "article",
          library: "وعظات",
          section: "الحاجة للدخول إلى الأعماق",
          language: "ar",
        },
      ]),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      normalized_query: "ايه معني الطريق الداخلي",
      kv: {
        lexical_type: "array",
        lexical_count: 1,
        sample_key: "wa3zat:ElTariqElDa5ely:0",
        sample_type: "object",
      },
      lexical: {
        candidate_count: 1,
        top_ids: ["wa3zat:ElTariqElDa5ely:0"],
      },
      hydration: {
        hydrated_count: 1,
        missing_ids: [],
      },
    });
    expect(JSON.stringify(body)).not.toContain("حلّ مشاكل الحياة");
  });

  test("rejects evaluator-only message controls for the proxy role", async () => {
    const env = createEnv([], { ASSISTANT_PROXY_TOKEN: "proxy-secret" });
    for (const payload of [
      { message: "test", retrieval_only: true },
      { message: "test", debug: true },
      { message: "test", normalized_query: "custom" },
      { message: "test", retrieval_query: "custom" },
    ]) {
      const response = await app.request(
        "/api/assistant/message",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-assistant-proxy-token": "proxy-secret",
          },
          body: JSON.stringify(payload),
        },
        env,
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "caller_capability_forbidden",
      });
    }
  });

  test("allows retrieval controls only for the evaluation role", async () => {
    const response = await app.request(
      "/api/assistant/message",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-eval-token": "eval-secret",
        },
        body: JSON.stringify({
          message: "internal path",
          retrieval_only: true,
          debug: true,
          normalized_query: "internal path",
        }),
      },
      createEnv([], { ASSISTANT_EVAL_TOKEN: "eval-secret" }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as AssistantMessageResponse;
    expect(body.confidence).toBe("retrieval_only");
  });

  test("restricts the retrieval debug endpoint to evaluators", async () => {
    const env = createEnv([], {
      ASSISTANT_PROXY_TOKEN: "proxy-secret",
      ASSISTANT_EVAL_TOKEN: "eval-secret",
    });
    const proxyResponse = await app.request(
      "/debug/retrieval",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-proxy-token": "proxy-secret",
        },
        body: JSON.stringify({ message: "test" }),
      },
      env,
    );
    expect(proxyResponse.status).toBe(403);

    const evalResponse = await app.request(
      "/debug/retrieval",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-eval-token": "eval-secret",
        },
        body: JSON.stringify({ message: "test" }),
      },
      env,
    );
    expect(evalResponse.status).toBe(200);
  });


  test("requires trusted proxy identities before retrieval", async () => {
    let chunkReads = 0;
    const response = await app.request("/api/assistant/message", {
      method: "POST",
      headers: { "content-type": "application/json", "x-assistant-proxy-token": "proxy-secret" },
      body: JSON.stringify({ message: "test" }),
    }, createEnv([], {
      ASSISTANT_PROXY_TOKEN: "proxy-secret",
      ASSISTANT_ACTOR_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ASSISTANT_NETWORK_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ASSISTANT_CHUNKS: { get: async () => { chunkReads += 1; return null; } },
    }));
    expect(response.status).toBe(503);
    expect(chunkReads).toBe(0);
  });

  test("fails closed before retrieval and model calls when D1 quota storage fails", async () => {
    let chunkReads = 0;
    let modelCalls = 0;
    const response = await app.request("/api/assistant/message", {
      method: "POST",
      headers: { "content-type": "application/json", "x-assistant-proxy-token": "proxy-secret" },
      body: JSON.stringify({
        actor_id: "actor-1",
        network_id: "network-1",
        actor_type: "anonymous",
        message: "test",
      }),
    }, createEnv([], {
      ASSISTANT_PROXY_TOKEN: "proxy-secret",
      ASSISTANT_ACTOR_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ASSISTANT_NETWORK_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ASSISTANT_CHUNKS: { get: async () => { chunkReads += 1; return null; } },
      ASSISTANT_FEEDBACK_DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => { throw new Error("d1 unavailable"); },
            all: async () => { throw new Error("d1 unavailable"); },
          }),
        }),
      },
      ASSISTANT_LLM_FETCH: async () => {
        modelCalls += 1;
        return new Response("{}");
      },
    }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as AssistantMessageResponse;
    expect(body.debug?.answer).toMatchObject({ mode: "fallback", reason: "quota_storage_unavailable" });
    expect(chunkReads).toBe(0);
    expect(modelCalls).toBe(0);
  });

});
