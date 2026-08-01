import { describe, expect, test } from "vitest";
import {
  createFallbackAnswerResponse,
  createGroundedAnswerResponse,
  createRetrievalOnlyResponse,
} from "../src/response";

describe("createRetrievalOnlyResponse", () => {
  test("returns raw retrieved chunks inside the stable assistant envelope", () => {
    const response = createRetrievalOnlyResponse({
      conversationId: "conversation-1",
      query: "ما معنى الطريق الداخلي؟",
      normalizedQuery: "ما معني الطريق الداخلي",
      chunks: [
        {
          doc_id: "wa3zat:ElTariqElDa5ely",
          chunk_id: "wa3zat:ElTariqElDa5ely:0",
          title: "الطريق الداخلي",
          url: "https://madraset-elshamamsa.com/articles/wa3zat/ElTariqElDa5ely.php",
          text: "## الحاجة للدخول إلى الأعماق\n\nحلّ مشاكل الحياة من الداخل.",
          score: 0.82,
          content_type: "article",
          library: "وعظات",
          section: "الحاجة للدخول إلى الأعماق",
          language: "ar",
        },
      ],
    });

    expect(response.answer).toBe("");
    expect(response.confidence).toBe("retrieval_only");
    expect(response.citations).toEqual([
      {
        title: "الطريق الداخلي",
        url: "https://madraset-elshamamsa.com/articles/wa3zat/ElTariqElDa5ely.php",
        snippet: "## الحاجة للدخول إلى الأعماق\n\nحلّ مشاكل الحياة من الداخل.",
      },
    ]);
    expect(response.retrieved_chunks[0]).not.toHaveProperty("search_text");
    expect(response.debug).toMatchObject({
      normalized_query: "ما معني الطريق الداخلي",
      retrieval_mode: "controlled_hybrid",
    });
  });
});

describe("createGroundedAnswerResponse", () => {
  test("deduplicates public citations and actions by URL while preserving cited chunk ids", () => {
    const response = createGroundedAnswerResponse({
      conversationId: "conversation-1",
      query: "Question?",
      normalizedQuery: "question",
      chunks: [
        {
          doc_id: "doc:same",
          chunk_id: "doc:same:1",
          title: "Same Source",
          url: "https://example.test/source",
          text: "First supporting chunk with enough source text for a citation.",
          score: 0.9,
        },
        {
          doc_id: "doc:same",
          chunk_id: "doc:same:2",
          title: "Same Source",
          url: "https://example.test/source",
          text: "Second supporting chunk with enough source text for a citation.",
          score: 0.8,
        },
      ],
      groundedAnswer: {
        answer: "Supported answer.",
        confidence: "high",
        cited_chunk_ids: ["doc:same:1", "doc:same:2"],
        citations: [
          {
            title: "Same Source",
            url: "https://example.test/source",
            snippet: "First supporting chunk with enough source text for a citation.",
          },
          {
            title: "Same Source",
            url: "https://example.test/source",
            snippet: "Second supporting chunk with enough source text for a citation.",
          },
        ],
      },
    });

    expect(response.citations).toEqual([
      {
        title: "Same Source",
        url: "https://example.test/source",
        snippet: "First supporting chunk with enough source text for a citation.",
      },
    ]);
    expect(response.suggested_actions).toEqual([
      {
        type: "navigate_to_url",
        label: "Same Source",
        url: "https://example.test/source",
      },
    ]);
  });
  test("surfaces high-score retrieved chunks when the model cannot answer", () => {
    const response = createGroundedAnswerResponse({
      conversationId: "conversation-1",
      query: "Question?",
      normalizedQuery: "question",
      chunks: [
        {
          doc_id: "doc:relevant",
          chunk_id: "doc:relevant:0",
          title: "Relevant Source",
          url: "https://example.test/relevant",
          text: "Relevant source text that may help the user continue reading.",
          score: 0.82,
        },
        {
          doc_id: "doc:weak",
          chunk_id: "doc:weak:0",
          title: "Weak Source",
          url: "https://example.test/weak",
          text: "Weak source text should not be shown as fallback evidence.",
          score: 0.12,
        },
      ],
      groundedAnswer: {
        answer: "I could not find a confirmed answer.",
        confidence: "low",
        cited_chunk_ids: [],
        citations: [],
      },
      answerDebug: {
        mode: "handoff",
        reason: "not_found_in_context",
      },
    });

    expect(response.answer).toBe("I could not find a confirmed answer.");
    expect(response.citations).toEqual([
      {
        title: "Relevant Source",
        url: "https://example.test/relevant",
        snippet: "Relevant source text that may help the user continue reading.",
      },
    ]);
    expect(response.suggested_actions).toEqual([
      {
        type: "navigate_to_url",
        label: "Relevant Source",
        url: "https://example.test/relevant",
      },
    ]);
    expect(response.debug?.answer).toEqual({
      mode: "handoff",
      reason: "not_found_in_context",
    });
  });

  test("does not surface low-score chunks when the model cannot answer", () => {
    const response = createGroundedAnswerResponse({
      conversationId: "conversation-1",
      query: "Question?",
      normalizedQuery: "question",
      chunks: [
        {
          doc_id: "doc:weak",
          chunk_id: "doc:weak:0",
          title: "Weak Source",
          url: "https://example.test/weak",
          text: "Weak source text should stay hidden from fallback citations.",
          score: 0.12,
        },
      ],
      groundedAnswer: {
        answer: "I could not find a confirmed answer.",
        confidence: "low",
        cited_chunk_ids: [],
        citations: [],
      },
      answerDebug: {
        mode: "handoff",
        reason: "not_found_in_context",
      },
    });

    expect(response.citations).toEqual([]);
    expect(response.suggested_actions).toEqual([]);
  });
});

describe("createFallbackAnswerResponse", () => {
  test("returns a friendly source fallback with search action and quota reason", () => {
    const response = createFallbackAnswerResponse({
      conversationId: "conversation-1",
      query: "Question?",
      normalizedQuery: "question",
      chunks: [
        {
          doc_id: "doc:one",
          chunk_id: "doc:one:0",
          title: "Useful Source",
          url: "https://madraset-elshamamsa.com/articles/html/Useful.php",
          text: "Source text that should become a citation snippet.",
          score: 0.9,
        },
      ],
      fallbackReason: "device_daily_quota",
    });

    expect(response.answer).toContain("وصلت للحد اليومي");
    expect(response.confidence).toBe("retrieval_only");
    expect(response.citations).toHaveLength(1);
    expect(response.suggested_actions).toEqual([
      {
        type: "navigate_to_url",
        label: "Useful Source",
        url: "https://madraset-elshamamsa.com/articles/html/Useful.php",
      },
      {
        type: "navigate_to_url",
        label: "بحث في الموقع",
        url: "https://madraset-elshamamsa.com/search.php",
      },
    ]);
    expect(response.debug?.answer).toEqual({
      mode: "fallback",
      reason: "device_daily_quota",
    });
  });
});


describe("createFallbackAnswerResponse fallback modes", () => {
  test("returns search-only fallback without citations", () => {
    const response = createFallbackAnswerResponse({
      conversationId: "conversation-1",
      query: "Question?",
      normalizedQuery: "question",
      chunks: [
        {
          doc_id: "doc:one",
          chunk_id: "doc:one:0",
          title: "Useful Source",
          url: "https://madraset-elshamamsa.com/articles/html/Useful.php",
          text: "Source text that should not be shown in search-only fallback.",
          score: 0.9,
        },
      ],
      fallbackReason: "device_daily_quota",
      fallbackMode: "search_only",
    });

    expect(response.citations).toEqual([]);
    expect(response.suggested_actions).toEqual([
      {
        type: "navigate_to_url",
        label: "بحث في الموقع",
        url: "https://madraset-elshamamsa.com/search.php",
      },
    ]);
  });
});

describe("public-site fallback actions", () => {
  test("uses the configured site URL for the search fallback", () => {
    const response = createFallbackAnswerResponse({
      conversationId: "conversation-1",
      query: "question",
      normalizedQuery: "question",
      chunks: [],
      fallbackReason: "model_provider_error",
      siteUrl: "https://library.example",
    });

    expect(response.suggested_actions).toContainEqual({
      type: "navigate_to_url",
      label: "بحث في الموقع",
      url: "https://library.example/search.php",
    });
  });
});