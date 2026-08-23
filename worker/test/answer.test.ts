import { describe, expect, test } from "vitest";
import {
  createGroundedAnswer,
  hasStrongRetrieval,
  validateModelAnswer,
} from "../src/answer";
import type { Env, RetrievedChunk } from "../src/types";

const chunks: RetrievedChunk[] = [
  {
    doc_id: "doc:internal-path",
    chunk_id: "doc:internal-path:0",
    title: "Internal Path",
    url: "https://example.test/internal-path",
    text: "The source says the internal path starts from the heart.",
    score: 0.82,
    content_type: "article",
    section: "Intro",
    language: "en",
  },
  {
    doc_id: "doc:repentance",
    chunk_id: "doc:repentance:2",
    title: "Repentance",
    url: "https://example.test/repentance",
    text: "Repentance is described as returning the heart to God.",
    score: 0.66,
    content_type: "article",
    section: "Meaning",
    language: "en",
  },
];

describe("hasStrongRetrieval", () => {
  test("requires at least one retrieved chunk with enough text", () => {
    expect(hasStrongRetrieval([])).toBe(false);
    expect(
      hasStrongRetrieval([
        {
          ...chunks[0],
          text: "Too short",
        },
      ]),
    ).toBe(false);
    expect(hasStrongRetrieval(chunks)).toBe(true);
  });
});

describe("validateModelAnswer", () => {
  test("keeps only citations that map to retrieved chunks", () => {
    const answer = validateModelAnswer(
      {
        answer: "The internal path starts from the heart.",
        cited_chunk_ids: ["doc:internal-path:0", "doc:missing:9"],
        confidence: "high",
      },
      chunks,
    );

    expect(answer).toEqual({
      answer: "The internal path starts from the heart.",
      confidence: "high",
      citations: [
        {
          title: "Internal Path",
          url: "https://example.test/internal-path",
          snippet: "The source says the internal path starts from the heart.",
        },
      ],
      cited_chunk_ids: ["doc:internal-path:0"],
    });
  });

  test("returns null when the model does not cite retrieved chunks", () => {
    expect(
      validateModelAnswer(
        {
          answer: "Unsupported answer.",
          cited_chunk_ids: ["doc:missing:9"],
          confidence: "medium",
        },
        chunks,
      ),
    ).toBeNull();
  });
});

describe("createGroundedAnswer", () => {
  test.each([
    { answerLanguage: "ar" as const, wrongAnswer: "The inner path begins in the heart." },
    { answerLanguage: "en" as const, wrongAnswer: "الطريق الداخلي يبدأ من القلب." },
  ])("rejects $answerLanguage answers written in the wrong language after one retry", async ({ answerLanguage, wrongAnswer }) => {
    let calls = 0;
    const result = await createGroundedAnswer({
      ASSISTANT_LLM_API_KEY: "key",
      ASSISTANT_LLM_FETCH: async () => {
        calls += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          status: "ANSWERED",
          answer: wrongAnswer,
          confidence: "high",
          cited_chunk_ids: ["doc:internal-path:0"],
        }) } }] }));
      },
    } as Env, { query: "What is the inner path?", chunks, answerLanguage });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ ok: false, reason: "wrong_answer_language", debug: { reason: "wrong_answer_language" } });
  });

  test("asks for an English grounded answer while preserving Arabic source terms", async () => {
    let systemPrompt = "";
    const result = await createGroundedAnswer({
      ASSISTANT_LLM_API_KEY: "key",
      ASSISTANT_LLM_FETCH: async (_url, init) => {
        const payload = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
        systemPrompt = payload.messages.find((message) => message.role === "system")?.content ?? "";
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          status: "ANSWERED",
          answer: "The الطريق الداخلي begins in the heart.",
          confidence: "high",
          cited_chunk_ids: ["doc:internal-path:0"],
        }) } }] }));
      },
    } as Env, { query: "What is the inner path?", chunks, answerLanguage: "en" });
    expect(result.ok && result.answer.answer).toContain("الطريق الداخلي");
    expect(systemPrompt).toContain("Answer in clear English");
    expect(systemPrompt).toContain("quoted terms exactly");
  });

  test("calls an OpenAI-compatible model with retrieved text and parses grounded JSON", async () => {
    const requests: Record<string, unknown>[] = [];
    const env: Env = {
      ASSISTANT_CHAT_MODEL: "google/gemini-flash-lite-test",
      ASSISTANT_LLM_API_KEY: "test-key",
      ASSISTANT_LLM_BASE_URL: "https://llm.example.test/v1",
      ASSISTANT_LLM_FETCH: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer: "The internal path starts from the heart.",
                    confidence: "high",
                    cited_chunk_ids: ["doc:internal-path:0"],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    };

    const result = await createGroundedAnswer(env, {
      query: "What is the internal path?",
      chunks,
    });

    expect(result).toMatchObject({
      ok: true,
      answer: {
        answer: "The internal path starts from the heart.",
        confidence: "high",
        cited_chunk_ids: ["doc:internal-path:0"],
      },
      debug: {
        mode: "grounded",
      },
    });
    expect(JSON.stringify(requests[0])).toContain(
      "The source says the internal path starts from the heart.",
    );
    expect(requests[0].temperature).toBe(0);
    expect(JSON.stringify(requests[0])).toContain("cited_chunk_ids");
    expect(JSON.stringify(requests[0])).not.toContain('"citations"');
    expect(JSON.stringify(requests[0])).not.toContain("search_text");
  });
  test("uses direct Gemini as the primary model provider when configured", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const env: Env = {
      ASSISTANT_CHAT_MODEL: "google/gemini-2.5-flash-lite",
      ASSISTANT_LLM_API_KEY: "fallback-key",
      ASSISTANT_GEMINI_API_KEY: "gemini-key",
      ASSISTANT_GEMINI_MODEL: "gemini-2.5-flash-lite",
      ASSISTANT_LLM_FETCH: async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        status: "ANSWERED",
                        answer: "The internal path starts from the heart.",
                        confidence: "high",
                        cited_chunk_ids: ["doc:internal-path:0"],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    };

    const result = await createGroundedAnswer(env, {
      query: "What is the internal path?",
      chunks,
    });

    expect(result).toMatchObject({
      ok: true,
      answer: {
        answer: "The internal path starts from the heart.",
        cited_chunk_ids: ["doc:internal-path:0"],
      },
      debug: {
        mode: "grounded",
        model_provider: "gemini",
        estimated_model_cost_usd: 0,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=gemini-key",
    );
    expect(calls[0].body).toMatchObject({
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0,
      },
    });
    expect(JSON.stringify(calls[0].body)).not.toContain("additionalProperties");
    expect(JSON.stringify(calls[0].body)).toContain(
      "The source says the internal path starts from the heart.",
    );
  });

  test("retries transient direct Gemini failures before succeeding", async () => {
    const statuses: number[] = [];
    let calls = 0;
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "google/gemini-2.5-flash-lite",
        ASSISTANT_LLM_API_KEY: "fallback-key",
        ASSISTANT_GEMINI_API_KEY: "gemini-key",
        ASSISTANT_GEMINI_MODEL: "gemini-2.5-flash-lite",
        ASSISTANT_GEMINI_MAX_ATTEMPTS: "2",
        ASSISTANT_LLM_FETCH: async () => {
          calls += 1;
          if (calls === 1) {
            statuses.push(429);
            return new Response("quota", { status: 429 });
          }
          statuses.push(200);
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          status: "ANSWERED",
                          answer: "The internal path starts from the heart.",
                          confidence: "high",
                          cited_chunk_ids: ["doc:internal-path:0"],
                        }),
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(statuses).toEqual([429, 200]);
    expect(result).toMatchObject({
      ok: true,
      debug: {
        mode: "grounded",
        attempts: 2,
        model_provider: "gemini",
        provider_fallback_reason: "gemini_http_429",
        estimated_model_cost_usd: 0,
      },
    });
  });

  test("falls back to OpenRouter Gemini when direct Gemini stays transiently unavailable", async () => {
    const urls: string[] = [];
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "google/gemini-2.5-flash-lite",
        ASSISTANT_LLM_API_KEY: "openrouter-key",
        ASSISTANT_GEMINI_API_KEY: "gemini-key",
        ASSISTANT_GEMINI_MODEL: "gemini-2.5-flash-lite",
        ASSISTANT_GEMINI_MAX_ATTEMPTS: "2",
        ASSISTANT_ESTIMATED_MODEL_COST_USD: "0.001",
        ASSISTANT_LLM_FETCH: async (url) => {
          urls.push(String(url));
          if (String(url).includes("generativelanguage.googleapis.com")) {
            return new Response("quota", { status: 429 });
          }
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      status: "ANSWERED",
                      answer: "The internal path starts from the heart.",
                      confidence: "high",
                      cited_chunk_ids: ["doc:internal-path:0"],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(urls.filter((url) => url.includes("generativelanguage.googleapis.com"))).toHaveLength(2);
    expect(urls.at(-1)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(result).toMatchObject({
      ok: true,
      debug: {
        mode: "grounded",
        attempts: 3,
        model_provider: "openrouter",
        provider_fallback_reason: "gemini_http_429",
        estimated_model_cost_usd: 0.001,
      },
    });
  });

  test("tries direct Gemini three times before falling back to OpenRouter", async () => {
    const urls: string[] = [];
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "google/gemini-2.5-flash-lite",
        ASSISTANT_LLM_API_KEY: "openrouter-key",
        ASSISTANT_GEMINI_API_KEY: "gemini-key",
        ASSISTANT_GEMINI_MODEL: "gemini-2.5-flash-lite",
        ASSISTANT_ESTIMATED_MODEL_COST_USD: "0.001",
        ASSISTANT_LLM_FETCH: async (url) => {
          urls.push(String(url));
          if (String(url).includes("generativelanguage.googleapis.com")) {
            return new Response("quota", { status: 429 });
          }
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      status: "ANSWERED",
                      answer: "The internal path starts from the heart.",
                      confidence: "high",
                      cited_chunk_ids: ["doc:internal-path:0"],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(urls.filter((url) => url.includes("generativelanguage.googleapis.com"))).toHaveLength(3);
    expect(urls.at(-1)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(result).toMatchObject({
      ok: true,
      debug: {
        mode: "grounded",
        attempts: 4,
        model_provider: "openrouter",
        provider_fallback_reason: "gemini_http_429",
        estimated_model_cost_usd: 0.001,
      },
    });
  });

  test("falls back to OpenRouter when direct Gemini returns empty provider content", async () => {
    const urls: string[] = [];
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "google/gemini-2.5-flash-lite",
        ASSISTANT_LLM_API_KEY: "openrouter-key",
        ASSISTANT_GEMINI_API_KEY: "gemini-key",
        ASSISTANT_GEMINI_MODEL: "gemini-2.5-flash-lite",
        ASSISTANT_GEMINI_MAX_ATTEMPTS: "3",
        ASSISTANT_ESTIMATED_MODEL_COST_USD: "0.001",
        ASSISTANT_LLM_FETCH: async (url) => {
          urls.push(String(url));
          if (String(url).includes("generativelanguage.googleapis.com")) {
            return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
          }
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      status: "ANSWERED",
                      answer: "The internal path starts from the heart.",
                      confidence: "high",
                      cited_chunk_ids: ["doc:internal-path:0"],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(urls.filter((url) => url.includes("generativelanguage.googleapis.com"))).toHaveLength(3);
    expect(result).toMatchObject({
      ok: true,
      debug: {
        mode: "grounded",
        attempts: 4,
        model_provider: "openrouter",
        provider_fallback_reason: "gemini_empty_content",
      },
    });
  });
  test("tries the next Gemini model before OpenRouter on provider failures", async () => {
    const urls: string[] = [];
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "google/gemini-2.5-flash-lite",
        ASSISTANT_LLM_API_KEY: "openrouter-key",
        ASSISTANT_GEMINI_API_KEY: "gemini-key",
        ASSISTANT_GEMINI_MODEL_LADDER: "gemini-2.5-flash-lite,gemini-2.5-flash",
        ASSISTANT_GEMINI_MAX_ATTEMPTS: "3",
        ASSISTANT_LLM_FETCH: async (url) => {
          urls.push(String(url));
          if (String(url).includes("/models/gemini-2.5-flash-lite:generateContent")) {
            return new Response("rate limited", { status: 429 });
          }
          if (String(url).includes("/models/gemini-2.5-flash:generateContent")) {
            return new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: JSON.stringify({
                            status: "ANSWERED",
                            answer: "The internal path starts from the heart.",
                            confidence: "high",
                            cited_chunk_ids: ["doc:internal-path:0"],
                          }),
                        },
                      ],
                    },
                  },
                ],
              }),
              { status: 200 },
            );
          }
          throw new Error(`unexpected URL ${url}`);
        },
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/models/gemini-2.5-flash-lite:generateContent");
    expect(urls[1]).toContain("/models/gemini-2.5-flash:generateContent");
    expect(urls.some((url) => url.includes("openrouter.ai"))).toBe(false);
    expect(result).toMatchObject({
      ok: true,
      debug: {
        mode: "grounded",
        model_provider: "gemini",
        model_name: "gemini-2.5-flash",
        provider_fallback_reason: "gemini_http_429",
      },
    });
    expect(result.ok && result.debug.mode === "grounded" ? result.debug.provider_attempts : []).toEqual([
      {
        provider: "gemini",
        model: "gemini-2.5-flash-lite",
        ok: false,
        reason: "llm_http_error",
        status: 429,
        fallback_reason: "gemini_http_429",
      },
      {
        provider: "gemini",
        model: "gemini-2.5-flash",
        ok: true,
      },
    ]);
  });

  test("tries a third Gemini model before OpenRouter on repeated provider failures", async () => {
    const urls: string[] = [];
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "google/gemini-2.5-flash-lite",
        ASSISTANT_LLM_API_KEY: "openrouter-key",
        ASSISTANT_GEMINI_API_KEY: "gemini-key",
        ASSISTANT_GEMINI_MODEL_LADDER: "gemini-2.5-flash-lite,gemini-2.5-flash,gemini-3-flash-preview",
        ASSISTANT_LLM_FETCH: async (url) => {
          urls.push(String(url));
          if (String(url).includes("/models/gemini-2.5-flash-lite:generateContent")) {
            return new Response("rate limited", { status: 429 });
          }
          if (String(url).includes("/models/gemini-2.5-flash:generateContent")) {
            return new Response("unavailable", { status: 503 });
          }
          if (String(url).includes("/models/gemini-3-flash-preview:generateContent")) {
            return new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: JSON.stringify({
                            status: "ANSWERED",
                            answer: "The internal path starts from the heart.",
                            confidence: "high",
                            cited_chunk_ids: ["doc:internal-path:0"],
                          }),
                        },
                      ],
                    },
                  },
                ],
              }),
              { status: 200 },
            );
          }
          throw new Error(`unexpected URL ${url}`);
        },
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain("/models/gemini-2.5-flash-lite:generateContent");
    expect(urls[1]).toContain("/models/gemini-2.5-flash:generateContent");
    expect(urls[2]).toContain("/models/gemini-3-flash-preview:generateContent");
    expect(urls.some((url) => url.includes("openrouter.ai"))).toBe(false);
    expect(result).toMatchObject({
      ok: true,
      debug: {
        mode: "grounded",
        model_provider: "gemini",
        model_name: "gemini-3-flash-preview",
        provider_fallback_reason: "gemini_http_503",
      },
    });
  });
  test("uses D1 quota windows to skip a Gemini model whose RPM is exhausted", async () => {
    const rows = [
      {
        provider: "gemini",
        model_name: "gemini-3.1-flash-lite",
        period_type: "rpm",
        period_key: "leaky",
        request_count: 15,
        estimated_tokens: 0,
        updated_at: new Date().toISOString(),
      },
    ];
    const urls: string[] = [];
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "google/gemini-2.5-flash-lite",
        ASSISTANT_LLM_API_KEY: "openrouter-key",
        ASSISTANT_GEMINI_API_KEY: "gemini-key",
        ASSISTANT_GEMINI_MODEL_LADDER: "gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-3-flash-preview",
        ASSISTANT_GEMINI_QUOTA_ROUTING_ENABLED: "true",
        ASSISTANT_FEEDBACK_DB: {
          prepare: (query) => ({
            bind: (...values) => ({
              all: async <T = Record<string, unknown>>() => {
                if (query.includes("FROM assistant_model_quota_windows")) {
                  const [provider, modelName, periodType, periodKey] = values.map(String);
                  const row = rows.find((item) =>
                    item.provider === provider &&
                    item.model_name === modelName &&
                    item.period_type === periodType &&
                    item.period_key === periodKey,
                  );
                  return { success: true, results: (row ? [row] : []) as T[] };
                }
                return { success: true, results: [] };
              },
              run: async () => ({ success: true, meta: { changes: 1 } }),
            }),
          }),
        },
        ASSISTANT_LLM_FETCH: async (url) => {
          urls.push(String(url));
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          status: "ANSWERED",
                          answer: "The internal path starts from the heart.",
                          confidence: "high",
                          cited_chunk_ids: ["doc:internal-path:0"],
                        }),
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/models/gemini-2.5-flash-lite:generateContent");
    expect(result).toMatchObject({
      ok: true,
      debug: {
        mode: "grounded",
        model_provider: "gemini",
        model_name: "gemini-2.5-flash-lite",
      },
    });
  });
  test("does not fall back to OpenRouter when Gemini says the answer is unsupported", async () => {
    const urls: string[] = [];
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "google/gemini-2.5-flash-lite",
        ASSISTANT_LLM_API_KEY: "openrouter-key",
        ASSISTANT_GEMINI_API_KEY: "gemini-key",
        ASSISTANT_GEMINI_MODEL_LADDER: "gemini-2.5-flash-lite,gemini-2.5-flash",
        ASSISTANT_LLM_FETCH: async (url) => {
          urls.push(String(url));
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          status: "NOT_FOUND_IN_BATCH",
                          answer: "",
                          confidence: "low",
                          cited_chunk_ids: [],
                        }),
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/models/gemini-2.5-flash-lite:generateContent");
    expect(urls.some((url) => url.includes("openrouter.ai"))).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      reason: "not_found_in_context",
      debug: {
        mode: "handoff",
        reason: "not_found_in_context",
      },
    });
  });

  test("uses compact evidence IDs and resolves citations when compact context is enabled", async () => {
    const requests: Record<string, unknown>[] = [];
    const env: Env = {
      ASSISTANT_CHAT_MODEL: "test/model",
      ASSISTANT_LLM_API_KEY: "test-key",
      ASSISTANT_COMPACT_CONTEXT_ENABLED: "true",
      ASSISTANT_CONTEXT_TOP_K: "1",
      ASSISTANT_CONTEXT_EXCERPT_CHARS: "200",
      ASSISTANT_CONTEXT_MAX_OUTPUT_TOKENS: "350",
      ASSISTANT_LLM_FETCH: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer: "The internal path starts from the heart.",
                    confidence: "high",
                    cited_chunk_ids: ["C1"],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    };

    const result = await createGroundedAnswer(env, {
      query: "What is the internal path?",
      chunks,
    });

    expect(result).toMatchObject({
      ok: true,
      answer: {
        cited_chunk_ids: ["doc:internal-path:0"],
        citations: [
          {
            title: "Internal Path",
            url: "https://example.test/internal-path",
          },
        ],
      },
      debug: {
        mode: "grounded",
        compact_context: true,
        context_chunks: 1,
      },
    });
    expect(requests[0].max_tokens).toBe(350);
    const request = requests[0] as { messages: Array<{ role: string; content: string }> };
    const userPayload = JSON.parse(request.messages[1].content) as { chunks: unknown[] };
    expect(userPayload.chunks[0]).toMatchObject({
      id: "C1",
      excerpt: "The source says the internal path starts from the heart.",
    });
    expect(JSON.stringify(userPayload)).not.toContain("https://example.test/internal-path");
    expect(JSON.stringify(userPayload)).not.toContain('"chunk_id":"doc:internal-path:0"');
    expect(request.messages[0].content).toContain("return evidence IDs like C1");
  });

  test("stops after the first progressive batch when the model answers from top chunk", async () => {
    const requests: Record<string, unknown>[] = [];
    const env: Env = {
      ASSISTANT_CHAT_MODEL: "test/model",
      ASSISTANT_LLM_API_KEY: "test-key",
      ASSISTANT_COMPACT_CONTEXT_ENABLED: "true",
      ASSISTANT_PROGRESSIVE_CONTEXT_ENABLED: "true",
      ASSISTANT_CONTEXT_BATCHES: "1,2,2",
      ASSISTANT_CONTEXT_TOP_K: "5",
      ASSISTANT_LLM_FETCH: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    status: "ANSWERED",
                    answer: "The internal path starts from the heart.",
                    confidence: "high",
                    cited_chunk_ids: ["C1"],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    };

    const result = await createGroundedAnswer(env, {
      query: "What is the internal path?",
      chunks,
    });

    expect(requests).toHaveLength(1);
    const request = requests[0] as { messages: Array<{ content: string }> };
    const userPayload = JSON.parse(request.messages[1].content) as { chunks: unknown[] };
    expect(userPayload.chunks).toHaveLength(1);
    expect(result).toMatchObject({
      ok: true,
      answer: {
        cited_chunk_ids: ["doc:internal-path:0"],
      },
      debug: {
        mode: "grounded",
        attempts: 1,
        batch_attempts: 1,
        context_chunks: 1,
      },
    });
  });

  test("continues to the next progressive batch when the model returns NOT_FOUND_IN_BATCH", async () => {
    const progressiveChunks: RetrievedChunk[] = [
      chunks[0],
      chunks[1],
      {
        doc_id: "doc:fasting",
        chunk_id: "doc:fasting:3",
        title: "Fasting",
        url: "https://example.test/fasting",
        text: "The source says fasting is joined with prayer and repentance.",
        score: 0.58,
      },
    ];
    const requests: Record<string, unknown>[] = [];
    let calls = 0;

    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "test/model",
        ASSISTANT_LLM_API_KEY: "test-key",
        ASSISTANT_COMPACT_CONTEXT_ENABLED: "true",
        ASSISTANT_PROGRESSIVE_CONTEXT_ENABLED: "true",
        ASSISTANT_CONTEXT_BATCHES: "1,2",
        ASSISTANT_CONTEXT_TOP_K: "3",
        ASSISTANT_LLM_FETCH: async (_url, init) => {
          calls += 1;
          requests.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify(
                      calls === 1
                        ? {
                          status: "NOT_FOUND_IN_BATCH",
                          answer: "",
                          confidence: "low",
                          cited_chunk_ids: [],
                        }
                        : {
                          status: "ANSWERED",
                          answer: "Fasting is joined with prayer and repentance.",
                          confidence: "high",
                          cited_chunk_ids: ["C2"],
                        },
                    ),
                  },
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
      {
        query: "What is fasting joined with?",
        chunks: progressiveChunks,
      },
    );

    expect(requests).toHaveLength(2);
    const firstPayload = JSON.parse((requests[0] as { messages: Array<{ content: string }> }).messages[1].content) as { chunks: unknown[] };
    const secondPayload = JSON.parse((requests[1] as { messages: Array<{ content: string }> }).messages[1].content) as { chunks: unknown[] };
    expect(firstPayload.chunks).toHaveLength(1);
    expect(secondPayload.chunks).toHaveLength(2);
    expect(secondPayload.chunks[0]).toMatchObject({ title: "Repentance" });
    expect(secondPayload.chunks[1]).toMatchObject({ title: "Fasting" });
    expect(result).toMatchObject({
      ok: true,
      answer: {
        answer: "Fasting is joined with prayer and repentance.",
        cited_chunk_ids: ["doc:fasting:3"],
      },
      debug: {
        mode: "grounded",
        attempts: 2,
        batch_attempts: 2,
        context_chunks: 2,
      },
    });
  });

  test("returns not_found_in_context when every progressive batch is unsupported", async () => {
    let calls = 0;
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "test/model",
        ASSISTANT_LLM_API_KEY: "test-key",
        ASSISTANT_COMPACT_CONTEXT_ENABLED: "true",
        ASSISTANT_PROGRESSIVE_CONTEXT_ENABLED: "true",
        ASSISTANT_CONTEXT_BATCHES: "1,1",
        ASSISTANT_CONTEXT_TOP_K: "2",
        ASSISTANT_LLM_FETCH: async () => {
          calls += 1;
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      status: "NOT_FOUND_IN_BATCH",
                      answer: "",
                      confidence: "low",
                      cited_chunk_ids: [],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(calls).toBe(2);
    expect(result).toMatchObject({
      ok: false,
      reason: "not_found_in_context",
      debug: {
        mode: "handoff",
        reason: "not_found_in_context",
        attempts: 2,
        batch_attempts: 2,
      },
    });
  });
  test("retries once when the model returns invalid JSON and keeps the second valid answer", async () => {
    let calls = 0;
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "test/model",
        ASSISTANT_LLM_API_KEY: "test-key",
        ASSISTANT_LLM_FETCH: async () => {
          calls += 1;
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      calls === 1
                        ? "not json"
                        : JSON.stringify({
                          answer: "The internal path starts from the heart.",
                          confidence: "high",
                          cited_chunk_ids: ["doc:internal-path:0"],
                        }),
                  },
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(calls).toBe(2);
    expect(result).toMatchObject({
      ok: true,
      answer: {
        answer: "The internal path starts from the heart.",
        cited_chunk_ids: ["doc:internal-path:0"],
      },
      debug: {
        mode: "grounded",
        attempts: 2,
      },
    });
  });

  test("retries once when the model returns an incomplete answer and keeps the repaired answer", async () => {
    const prompts: string[] = [];
    let calls = 0;
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "test/model",
        ASSISTANT_LLM_API_KEY: "test-key",
        ASSISTANT_LLM_FETCH: async (_url, init) => {
          calls += 1;
          const request = JSON.parse(String(init?.body)) as {
            messages: Array<{ role: string; content: string }>;
          };
          prompts.push(String(request.messages[0]?.content ?? ""));
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      answer:
                        calls === 1
                          ? "Peter passed through stages in his love. At first, he was"
                          : "Peter passed through stages in his love. At first, his love was emotional, then it matured through repentance and service.",
                      confidence: "high",
                      cited_chunk_ids: ["doc:internal-path:0"],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(calls).toBe(2);
    expect(prompts[1]).toContain("Previous answer was incomplete");
    expect(result).toMatchObject({
      ok: true,
      answer: {
        answer:
          "Peter passed through stages in his love. At first, his love was emotional, then it matured through repentance and service.",
      },
      debug: {
        mode: "grounded",
        attempts: 2,
      },
    });
  });

  test("returns incomplete_answer after one failed retry", async () => {
    let calls = 0;
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "test/model",
        ASSISTANT_LLM_API_KEY: "test-key",
        ASSISTANT_LLM_FETCH: async () => {
          calls += 1;
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      answer: "At first, he was",
                      confidence: "high",
                      cited_chunk_ids: ["doc:internal-path:0"],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(calls).toBe(2);
    expect(result).toMatchObject({
      ok: false,
      reason: "incomplete_answer",
      debug: {
        mode: "handoff",
        reason: "incomplete_answer",
        attempts: 2,
      },
    });
  });

  test("prompt allows constrained markdown and warns about conflicting chunks and remedies", async () => {
    const requests: Record<string, unknown>[] = [];
    await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "test/model",
        ASSISTANT_LLM_API_KEY: "test-key",
        ASSISTANT_LLM_FETCH: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      answer: "**Answer:** supported by the source.",
                      confidence: "high",
                      cited_chunk_ids: ["doc:internal-path:0"],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
      {
        query: "Question?",
        chunks,
      },
    );

    const systemPrompt = JSON.stringify(requests[0]);
    expect(systemPrompt).toContain("Markdown");
    expect(systemPrompt).toContain("prefer chunks whose title or section best matches");
    expect(systemPrompt).toContain("Do not confuse remedies, protections, or safeguards");
    expect(systemPrompt).toContain("Do not include raw HTML");
  });

  test("returns invalid_json after one failed retry", async () => {
    let calls = 0;
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "test/model",
        ASSISTANT_LLM_API_KEY: "test-key",
        ASSISTANT_LLM_FETCH: async () => {
          calls += 1;
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "not json" } }],
            }),
            { status: 200 },
          );
        },
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(calls).toBe(2);
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid_json",
      debug: {
        mode: "handoff",
        reason: "invalid_json",
        attempts: 2,
      },
    });
  });

  test("returns weak_retrieval when no retrieved chunk is usable", async () => {
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "test/model",
        ASSISTANT_LLM_API_KEY: "test-key",
      },
      {
        query: "Question?",
        chunks: [],
      },
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "weak_retrieval",
      debug: {
        mode: "handoff",
        reason: "weak_retrieval",
      },
    });
  });

  test("returns missing_config before calling the model when API config is incomplete", async () => {
    let called = false;
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "test/model",
        ASSISTANT_LLM_FETCH: async () => {
          called = true;
          return new Response("{}", { status: 200 });
        },
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "missing_config",
      debug: {
        mode: "handoff",
        reason: "missing_config",
      },
    });
    expect(called).toBe(false);
  });

  test("returns llm_http_error when the model endpoint rejects the request", async () => {
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "test/model",
        ASSISTANT_LLM_API_KEY: "test-key",
        ASSISTANT_LLM_FETCH: async () => new Response("rate limited", { status: 429 }),
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "llm_http_error",
      status: 429,
      debug: {
        mode: "handoff",
        reason: "llm_http_error",
        status: 429,
      },
    });
  });

  test("returns invalid_json when model content is not parseable JSON", async () => {
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "test/model",
        ASSISTANT_LLM_API_KEY: "test-key",
        ASSISTANT_LLM_FETCH: async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "not json" } }],
            }),
            { status: 200 },
          ),
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "invalid_json",
      debug: {
        mode: "handoff",
        reason: "invalid_json",
      },
    });
  });

  test("returns no_valid_citations when model cites chunks that were not retrieved", async () => {
    const result = await createGroundedAnswer(
      {
        ASSISTANT_CHAT_MODEL: "test/model",
        ASSISTANT_LLM_API_KEY: "test-key",
        ASSISTANT_LLM_FETCH: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      answer: "Unsupported answer.",
                      confidence: "medium",
                      cited_chunk_ids: ["missing"],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      },
      {
        query: "Question?",
        chunks,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "no_valid_citations",
      debug: {
        mode: "handoff",
        reason: "no_valid_citations",
      },
    });
  });
});
