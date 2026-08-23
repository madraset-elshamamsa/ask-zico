import { describe, expect, test } from "vitest";
import { detectMessageLanguage, isMeaningfullyArabic, translateEnglishRetrievalQuery } from "../src/language";
import type { Env } from "../src/types";

describe("detectMessageLanguage", () => {
  test("classifies Arabic-script messages as Arabic", () => expect(detectMessageLanguage("ما معنى الطريق الداخلي؟")).toBe("ar"));
  test("classifies Latin-script messages as English", () => expect(detectMessageLanguage("What does the inner path mean?")).toBe("en"));
  test("keeps mixed Arabic questions in the Arabic retrieval path", () => expect(detectMessageLanguage("ما معنى inner path؟")).toBe("ar"));
  test("rejects unsupported scripts", () => expect(detectMessageLanguage("こんにちは")).toBe("unsupported"));
  test("rejects messages containing unsupported letter scripts", () => expect(detectMessageLanguage("hello こんにちは")).toBe("unsupported"));
  test("does not classify French or Spanish prose as English merely because it uses Latin script", () => {
    expect(detectMessageLanguage("Bonjour, comment allez-vous ?")).toBe("unsupported");
    expect(detectMessageLanguage("¿Qué significa el camino interior?")).toBe("unsupported");
    expect(detectMessageLanguage("Dimmi il significato")).toBe("unsupported");
    expect(detectMessageLanguage("Explique le bapteme")).toBe("unsupported");
    expect(detectMessageLanguage("Dime el significado")).toBe("unsupported");
    expect(detectMessageLanguage("Was ist Taufe")).toBe("unsupported");
    expect(detectMessageLanguage("Diga o significado")).toBe("unsupported");
    expect(detectMessageLanguage("baptême")).toBe("unsupported");
    expect(detectMessageLanguage("resurrección")).toBe("unsupported");
  });
  test("keeps English questions and compact hymn or proper-name lookups supported", () => {
    expect(detectMessageLanguage("What does the inner path mean?")).toBe("en");
    expect(detectMessageLanguage("Omonogenis")).toBe("en");
    expect(detectMessageLanguage("Saint Athanasius")).toBe("en");
    expect(detectMessageLanguage("baptism")).toBe("en");
    expect(detectMessageLanguage("explain baptism")).toBe("en");
    expect(detectMessageLanguage("resurrection")).toBe("en");
    expect(detectMessageLanguage("hymn timing")).toBe("en");
    expect(detectMessageLanguage("when is the hymn chanted")).toBe("en");
    expect(detectMessageLanguage("what does baptism mean")).toBe("en");
    expect(detectMessageLanguage("Jesus miracles")).toBe("en");
    expect(detectMessageLanguage("vespers incense")).toBe("en");
    expect(detectMessageLanguage("martyrdom")).toBe("en");
    expect(detectMessageLanguage("Bible genealogy")).toBe("en");
  });

  test("translates English retrieval queries through Gemini", async () => {
    const result = await translateEnglishRetrievalQuery("What is the inner path?", {
      ASSISTANT_GEMINI_API_KEY: "gemini-key",
      ASSISTANT_LLM_FETCH: async (_url, init) => {
        expect(JSON.stringify(init?.body)).toContain("What is the inner path?");
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ما هو الطريق الداخلي؟" }] } }] }));
      },
    } as Env);
    expect(result).toMatchObject({ ok: true, query: "ما هو الطريق الداخلي؟", provider: "gemini", estimatedModelCostUsd: 0.001 });
  });

  test("uses OpenRouter when Gemini has a provider failure", async () => {
    const result = await translateEnglishRetrievalQuery("What is the inner path?", {
      ASSISTANT_GEMINI_API_KEY: "gemini-key", ASSISTANT_LLM_API_KEY: "openrouter-key", ASSISTANT_CHAT_MODEL: "test/model",
      ASSISTANT_LLM_FETCH: async (url) => String(url).includes("generativelanguage") ? new Response("busy", { status: 503 }) : new Response(JSON.stringify({ choices: [{ message: { content: "ما هو الطريق الداخلي؟" } }] })),
    } as Env);
    expect(result).toMatchObject({ ok: true, query: "ما هو الطريق الداخلي؟", provider: "openrouter" });
  });

  test("uses OpenRouter when Gemini returns invalid non-Arabic output", async () => {
    const result = await translateEnglishRetrievalQuery("What is the inner path?", {
      ASSISTANT_GEMINI_API_KEY: "gemini-key", ASSISTANT_LLM_API_KEY: "openrouter-key",
      ASSISTANT_LLM_FETCH: async (url) => String(url).includes("generativelanguage")
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "inner path" }] } }] }))
        : new Response(JSON.stringify({ choices: [{ message: { content: "ما هو الطريق الداخلي؟" } }] })),
    } as Env);
    expect(result).toMatchObject({ ok: true, query: "ما هو الطريق الداخلي؟", provider: "openrouter" });
  });

  test.each(["المعمودية", "القيامة", "صوم", "صلاة", "صليب", "قداس"])("accepts a substantive one-word Arabic translation: %s", async (translatedQuery) => {
    const result = await translateEnglishRetrievalQuery("baptism", {
      ASSISTANT_GEMINI_API_KEY: "gemini-key",
      ASSISTANT_LLM_FETCH: async () => new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: translatedQuery }] } }],
      })),
    } as Env);
    expect(result).toMatchObject({ ok: true, provider: "gemini", query: translatedQuery });
  });

  test("rejects a non-substantive two-letter Arabic translation", () => {
    expect(isMeaningfullyArabic("ال")).toBe(false);
  });

  test("rejects mostly-English Gemini output containing only a token Arabic fragment", async () => {
    let calls = 0;
    const result = await translateEnglishRetrievalQuery("What is the inner path?", {
      ASSISTANT_GEMINI_API_KEY: "gemini-key",
      ASSISTANT_LLM_API_KEY: "openrouter-key",
      ASSISTANT_LLM_FETCH: async (url) => {
        calls += 1;
        return String(url).includes("generativelanguage")
          ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ال inner path meaning and explanation" }] } }] }))
          : new Response(JSON.stringify({ choices: [{ message: { content: "ما معنى الطريق الداخلي؟" } }] }));
      },
    } as Env);
    expect(calls).toBe(2);
    expect(result).toMatchObject({ ok: true, provider: "openrouter", query: "ما معنى الطريق الداخلي؟" });
  });

  test("requires Arabic to be the clear majority while allowing one preserved title", async () => {
    let calls = 0;
    const result = await translateEnglishRetrievalQuery("When is Omonogenis chanted?", {
      ASSISTANT_GEMINI_API_KEY: "gemini-key",
      ASSISTANT_LLM_API_KEY: "openrouter-key",
      ASSISTANT_LLM_FETCH: async (url) => {
        calls += 1;
        return String(url).includes("generativelanguage")
          ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ما معنى الطريق الداخلي inner path meaning" }] } }] }))
          : new Response(JSON.stringify({ choices: [{ message: { content: "متى يُقال لحن Omonogenis؟" } }] }));
      },
    } as Env);
    expect(calls).toBe(2);
    expect(result).toMatchObject({ ok: true, provider: "openrouter", query: "متى يُقال لحن Omonogenis؟" });
  });

  test("returns a translation failure without inventing an Arabic query", async () => {
    const result = await translateEnglishRetrievalQuery("What is the inner path?", { ASSISTANT_GEMINI_API_KEY: "gemini-key", ASSISTANT_LLM_FETCH: async () => new Response("busy", { status: 503 }) } as Env);
    expect(result).toMatchObject({ ok: false, status: "failed", estimatedModelCostUsd: 0.001 });
  });

  test("returns missing_config without using OpenRouter as the primary translator", async () => {
    let calls = 0;
    const result = await translateEnglishRetrievalQuery("What is the inner path?", {
      ASSISTANT_LLM_API_KEY: "openrouter-key",
      ASSISTANT_LLM_FETCH: async () => { calls += 1; return new Response("unexpected"); },
    } as Env);
    expect(result).toMatchObject({ ok: false, status: "missing_config" });
    expect(calls).toBe(0);
  });
});
