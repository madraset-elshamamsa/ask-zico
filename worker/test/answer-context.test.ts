import { describe, expect, test } from "vitest";
import {
  buildAnswerContext,
  compactContextEnabled,
  parseAnswerContextOptions,
} from "../src/answer-context";
import type { Env, RetrievedChunk } from "../src/types";

const chunks: RetrievedChunk[] = [
  {
    doc_id: "doc:heart",
    chunk_id: "doc:heart:0",
    title: "Internal Path",
    url: "https://example.test/internal-path",
    section: "Intro",
    content_type: "article",
    language: "en",
    score: 0.91,
    text:
      "Opening paragraph with general background. The internal path starts from the heart and continues through repentance. Closing paragraph with extra material that should be trimmed away.",
  },
  {
    doc_id: "doc:service",
    chunk_id: "doc:service:1",
    title: "Service",
    url: "https://example.test/service",
    section: "Practice",
    content_type: "article",
    language: "en",
    score: 0.72,
    text: "Service is described as love that becomes visible through action.",
  },
];

describe("compactContextEnabled", () => {
  test("is enabled only by an explicit true string", () => {
    expect(compactContextEnabled({})).toBe(false);
    expect(compactContextEnabled({ ASSISTANT_COMPACT_CONTEXT_ENABLED: "false" })).toBe(false);
    expect(compactContextEnabled({ ASSISTANT_COMPACT_CONTEXT_ENABLED: "true" })).toBe(true);
  });
});

describe("parseAnswerContextOptions", () => {
  test("uses conservative defaults and clamps invalid values", () => {
    expect(parseAnswerContextOptions({})).toEqual({
      topK: 3,
      excerptChars: 1200,
    });

    expect(
      parseAnswerContextOptions({
        ASSISTANT_CONTEXT_TOP_K: "99",
        ASSISTANT_CONTEXT_EXCERPT_CHARS: "20",
      }),
    ).toEqual({
      topK: 8,
      excerptChars: 200,
    });
  });

  test("does not cap large configured excerpts by default", () => {
    expect(
      parseAnswerContextOptions({
        ASSISTANT_CONTEXT_EXCERPT_CHARS: "7000",
      }),
    ).toEqual({
      topK: 3,
      excerptChars: 7000,
    });
  });

  test("caps large excerpts only when an explicit max is configured", () => {
    expect(
      parseAnswerContextOptions({
        ASSISTANT_CONTEXT_EXCERPT_CHARS: "7000",
        ASSISTANT_CONTEXT_MAX_EXCERPT_CHARS: "4000",
      }),
    ).toEqual({
      topK: 3,
      excerptChars: 4000,
    });
  });
});

describe("buildAnswerContext", () => {
  test("returns full chunks and identity citation mapping when compact mode is disabled", () => {
    const context = buildAnswerContext({
      env: {},
      query: "internal path",
      chunks,
    });

    expect(context.compact).toBe(false);
    expect(context.modelChunks).toEqual([
      {
        chunk_id: "doc:heart:0",
        title: "Internal Path",
        url: "https://example.test/internal-path",
        section: "Intro",
        content_type: "article",
        text: chunks[0].text,
      },
      {
        chunk_id: "doc:service:1",
        title: "Service",
        url: "https://example.test/service",
        section: "Practice",
        content_type: "article",
        text: chunks[1].text,
      },
    ]);
    expect(context.resolveCitationId("doc:heart:0")).toBe("doc:heart:0");
    expect(context.debug).toBeUndefined();
  });

  test("uses short evidence IDs, no URLs, and query-focused excerpts in compact mode", () => {
    const env: Env = {
      ASSISTANT_COMPACT_CONTEXT_ENABLED: "true",
      ASSISTANT_CONTEXT_TOP_K: "1",
      ASSISTANT_CONTEXT_EXCERPT_CHARS: "80",
    };

    const context = buildAnswerContext({
      env,
      query: "Where does the internal path start?",
      chunks,
    });

    expect(context.compact).toBe(true);
    expect(context.modelChunks).toHaveLength(1);
    expect(context.modelChunks[0]).toEqual({
      id: "C1",
      title: "Internal Path",
      section: "Intro",
      content_type: "article",
      excerpt: expect.stringContaining("internal path starts from the heart"),
    });
    expect(JSON.stringify(context.modelChunks)).not.toContain("https://example.test");
    expect(JSON.stringify(context.modelChunks)).not.toContain("chunk_id");
    expect(context.resolveCitationId("C1")).toBe("doc:heart:0");
    expect(context.resolveCitationId("doc:heart:0")).toBe("doc:heart:0");
    expect(context.debug).toEqual({
      compact_context: true,
      context_chunks: 1,
      context_excerpt_chars: 200,
      input_chunk_chars: chunks[0].text.length + chunks[1].text.length,
      model_context_chars: expect.any(Number),
    });
    expect(context.debug?.model_context_chars).toBeLessThan(chunks[0].text.length + chunks[1].text.length);
  });

  test("can build compact context from a selected batch while preserving evidence order", () => {
    const context = buildAnswerContext({
      env: {
        ASSISTANT_COMPACT_CONTEXT_ENABLED: "true",
        ASSISTANT_CONTEXT_TOP_K: "2",
      },
      query: "service",
      chunks,
      selectedChunks: [chunks[1]],
    });

    expect(context.modelChunks).toEqual([
      {
        id: "C1",
        title: "Service",
        section: "Practice",
        content_type: "article",
        excerpt: "Service is described as love that becomes visible through action.",
      },
    ]);
    expect(context.resolveCitationId("C1")).toBe("doc:service:1");
    expect(context.debug).toMatchObject({
      compact_context: true,
      context_chunks: 1,
    });
  });
  test("falls back to the chunk opening when query terms do not overlap text", () => {
    const context = buildAnswerContext({
      env: {
        ASSISTANT_COMPACT_CONTEXT_ENABLED: "true",
        ASSISTANT_CONTEXT_TOP_K: "1",
        ASSISTANT_CONTEXT_EXCERPT_CHARS: "60",
      },
      query: "unrelated semantic question",
      chunks,
    });

    expect(context.modelChunks[0]).toMatchObject({
      id: "C1",
      excerpt: expect.stringContaining("Opening paragraph"),
    });
  });
});
