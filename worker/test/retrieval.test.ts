import { describe, expect, test, vi } from "vitest";
import { retrieveChunks } from "../src/retrieval";
import type { Env, StoredChunk } from "../src/types";

const lookupChunks: Record<string, StoredChunk> = {
  "wa3zat:ElTariqElDa5ely:0": {
    doc_id: "wa3zat:ElTariqElDa5ely",
    chunk_id: "wa3zat:ElTariqElDa5ely:0",
    title: "الطريق الداخلي",
    url: "https://madraset-elshamamsa.com/articles/wa3zat/ElTariqElDa5ely.php",
    text: "حلّ مشاكل الحياة بالنسبة للإنسان بيكون من الداخل.",
    search_text: "الطريق الداخلي حل مشاكل الحياه بالنسبه للانسان بيكون من الداخل",
    content_type: "article",
    library: "وعظات",
    section: "الحاجة للدخول إلى الأعماق",
    language: "ar",
  },
  "wa3zat:Ef5arestia:0": {
    doc_id: "wa3zat:Ef5arestia",
    chunk_id: "wa3zat:Ef5arestia:0",
    title: "الإفخارستيا في مزمور 111",
    url: "https://madraset-elshamamsa.com/articles/wa3zat/Ef5arestia.php",
    text: "الإفخارستيا هي ذبيحة شكر وذكرى خلاص المسيح.",
    search_text: "الافخارستيا هي ذبيحه شكر وذكري خلاص المسيح",
    content_type: "article",
    library: "وعظات",
    section: "المحتوى",
    language: "ar",
  },
};

type KvCall = {
  key: string;
  options: unknown;
};

function createEnv(kvCalls: KvCall[] = []): Env {
  return {
    RETRIEVAL_TOP_K: "2",
    RETRIEVAL_CANDIDATE_K: "10",
    ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
    ASSISTANT_AI: {
      run: async () => ({
        data: [[0.1, 0.2, 0.3]],
      }),
    },
    ASSISTANT_VECTORIZE: {
      query: async () => ({
        matches: [
          {
            id: "wa3zat:Ef5arestia:0",
            score: 0.91,
          },
        ],
      }),
    },
    ASSISTANT_CHUNKS: {
      get: async (key, options) => {
        kvCalls.push({ key, options });
        if (key === "lexical:wa3zat") {
          return [lookupChunks["wa3zat:ElTariqElDa5ely:0"]];
        }

        return lookupChunks[key] ?? null;
      },
    },
  };
}

describe("retrieveChunks", () => {
  test("skips lexical loading when vector retrieval hydrates enough results for a normal query", async () => {
    const kvCalls: KvCall[] = [];
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "2",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async () => ({
            matches: [
              {
                id: "doc:Eucharist:0",
                score: 0.91,
              },
            ],
          }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key, options) => {
            kvCalls.push({ key, options });
            if (key === "lexical:wa3zat") {
              return [lookupChunks["wa3zat:ElTariqElDa5ely:0"]];
            }
            if (key === "doc:Eucharist:0") {
              return {
                doc_id: "doc:Eucharist",
                chunk_id: "doc:Eucharist:0",
                title: "Eucharist",
                url: "https://example.test/eucharist",
                text: "A normal hydrated vector result.",
                search_text: "eucharist meaning",
              };
            }
            return null;
          },
        },
      },
      "meaning eucharist",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["doc:Eucharist:0"]);
    expect(chunks[0]).toMatchObject({
      doc_id: "doc:Eucharist",
    });
    expect(chunks[0]).not.toHaveProperty("search_text");
    expect(kvCalls.map((call) => call.key)).not.toContain("lexical:wa3zat");
    expect(kvCalls).toContainEqual({
      key: "doc:Eucharist:0",
      options: { type: "json" },
    });
  });

  test("runs lexical retrieval for ritual boundary questions despite a confident vector result", async () => {
    const kvCalls: KvCall[] = [];
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async () => ({
            matches: [
              {
                id: "taqs:OdasMaw3ozin:0",
                score: 0.91,
              },
            ],
          }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key, options) => {
            kvCalls.push({ key, options });
            if (key === "lexical:domain:taqs") {
              return [
                {
                  doc_id: "taqs:SalatElSol7",
                  chunk_id: "taqs:SalatElSol7:0",
                  title: "صلاة الصلح",
                  url: "https://example.test/salat-el-sol7",
                  search_text: "صلاة الصلح هي الصلاة اللي نبدأ بيها قداس المؤمنين بعد قانون الإيمان وأبونا بيبدأ بنفسه",
                  semanticDomain: "taqs",
                },
                {
                  doc_id: "taqs:GenericMass",
                  chunk_id: "taqs:GenericMass:0",
                  title: "قداس المؤمنين",
                  url: "https://example.test/generic-mass",
                  search_text: "شرح عام لقداس المؤمنين",
                  semanticDomain: "taqs",
                },
              ];
            }
            if (key === "taqs:OdasMaw3ozin:0") {
              return {
                doc_id: "taqs:OdasMaw3ozin",
                chunk_id: "taqs:OdasMaw3ozin:0",
                title: "قداس الموعوظين",
                url: "https://example.test/odas-maw3ozin",
                text: "شرح قراءات قداس الموعوظين.",
                semanticDomain: "taqs",
              };
            }
            if (key === "taqs:GenericMass:0") {
              return {
                doc_id: "taqs:GenericMass",
                chunk_id: "taqs:GenericMass:0",
                title: "قداس المؤمنين",
                url: "https://example.test/generic-mass",
                text: "شرح عام لقداس المؤمنين.",
                semanticDomain: "taqs",
              };
            }
            if (key === "taqs:SalatElSol7:0") {
              return {
                doc_id: "taqs:SalatElSol7",
                chunk_id: "taqs:SalatElSol7:0",
                title: "صلاة الصلح",
                url: "https://example.test/salat-el-sol7",
                text: "صلاة الصلح هي الصلاة اللي نبدأ بيها قداس المؤمنين بعد قانون الإيمان.",
                semanticDomain: "taqs",
              };
            }
            return null;
          },
        },
      },
      "قداس المؤمنين يبدء بايه",
    );

    expect(kvCalls.map((call) => call.key)).toContain("lexical:domain:taqs");
    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["taqs:SalatElSol7:0"]);
  });

  test("fuses vector and lexical candidates by stable chunk_id and hydrates original text", async () => {
    const kvCalls: KvCall[] = [];
    const chunks = await retrieveChunks(createEnv(kvCalls), "الطريق الداخلي");

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([
      "wa3zat:ElTariqElDa5ely:0",
      "wa3zat:Ef5arestia:0",
    ]);
    expect(chunks[0]).toMatchObject({
      doc_id: "wa3zat:ElTariqElDa5ely",
      title: "الطريق الداخلي",
      text: "حلّ مشاكل الحياة بالنسبة للإنسان بيكون من الداخل.",
    });
    expect(chunks[1]).toMatchObject({
      doc_id: "wa3zat:Ef5arestia",
      title: "الإفخارستيا في مزمور 111",
      text: "الإفخارستيا هي ذبيحة شكر وذكرى خلاص المسيح.",
    });
    expect(chunks[0]).not.toHaveProperty("search_text");
    expect(kvCalls).toContainEqual({
      key: "lexical:wa3zat",
      options: { type: "json" },
    });
    expect(kvCalls).toContainEqual({
      key: "wa3zat:Ef5arestia:0",
      options: { type: "json" },
    });
  });

  test("keeps a lexical fallback when vector bindings are unavailable", async () => {
    const env = createEnv();
    delete env.ASSISTANT_AI;
    delete env.ASSISTANT_VECTORIZE;

    const chunks = await retrieveChunks(env, "الطريق الداخلي");

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      chunk_id: "wa3zat:ElTariqElDa5ely:0",
      text: "حلّ مشاكل الحياة بالنسبة للإنسان بيكون من الداخل.",
      score: expect.any(Number),
    });
  });

  test("loads only routed domain lexical shards", async () => {
    const kvCalls: KvCall[] = [];
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "2",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_CHUNKS: {
          get: async (key, options) => {
            kvCalls.push({ key, options });
            if (key === "lexical:domain:ta3lim") {
              return [lookupChunks["wa3zat:Ef5arestia:0"]];
            }
            if (key === "lexical:domain:bible") {
              return [
                {
                  doc_id: "bible-summary:Genesis",
                  chunk_id: "bible-summary:Genesis:0",
                  title: "Genesis",
                  url: "https://madraset-elshamamsa.com/articles/Ketab/Genesis.php",
                  content_type: "bible_summary",
                  library: "Bible Summary",
                  section: "Creation",
                  language: "en",
                  semanticDomain: "bible",
                  facets: ["bible", "book"],
                  summary: "creation covenant genesis summary",
                  keywords: ["genesis", "covenant"],
                },
              ];
            }

            if (key === "bible-summary:Genesis:0") {
              return {
                doc_id: "bible-summary:Genesis",
                chunk_id: "bible-summary:Genesis:0",
                title: "Genesis",
                url: "https://madraset-elshamamsa.com/articles/Ketab/Genesis.php",
                text: "Creation and covenant summary text.",
                search_text: "creation covenant genesis summary",
                content_type: "bible_summary",
                library: "Bible Summary",
                section: "Creation",
                language: "en",
              };
            }

            return lookupChunks[key] ?? null;
          },
        },
      },
      "genesis covenant",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([
      "bible-summary:Genesis:0",
    ]);
    expect(chunks[0]).not.toHaveProperty("search_text");
    expect(kvCalls.map((call) => call.key)).toContain("lexical:domain:bible");
    expect(kvCalls.map((call) => call.key)).not.toContain("lexical:domain:al7an");
  });

  test("falls back from empty hymn corpus to adjacent ritual candidates", async () => {
    const kvCalls: KvCall[] = [];
    const chunks = await retrieveChunks(
      {
        ASSISTANT_AL7AN_ENABLED: "true",
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async () => ({
            matches: [],
          }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key, options) => {
            kvCalls.push({ key, options });
            if (key === "lexical:domain:al7an") {
              return [];
            }
            if (key === "lexical:domain:taqs") {
              return [
                {
                  doc_id: "taqs:ToniaRitual",
                  chunk_id: "taqs:ToniaRitual:0",
                  title: "Tonia ritual hymns",
                  url: "https://example.test/tonia",
                  semanticDomain: "taqs",
                  search_text: "tonia vestment ritual hymns said while wearing the tunia",
                },
              ];
            }
            if (key === "lexical:domain:bible" || key === "lexical:domain:ta3lim") {
              return [];
            }
            if (key === "lexical:facet:bible-summary-detail" || key === "lexical:metadata") {
              return [];
            }
            if (key === "taqs:ToniaRitual:0") {
              return {
                doc_id: "taqs:ToniaRitual",
                chunk_id: "taqs:ToniaRitual:0",
                title: "Tonia ritual hymns",
                url: "https://example.test/tonia",
                text: "A ritual source about the hymns said while wearing the tunia.",
                semanticDomain: "taqs",
              };
            }
            return null;
          },
        },
      },
      "hymn while wearing tunia",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["taqs:ToniaRitual:0"]);
    expect(kvCalls.map((call) => call.key)).toContain("lexical:domain:al7an");
    expect(kvCalls.map((call) => call.key)).toContain("lexical:domain:taqs");
  });

  test("falls back from empty hymn corpus to adjacent Bible candidates", async () => {
    const kvCalls: KvCall[] = [];
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_AL7AN_ENABLED: "true",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async () => ({
            matches: [],
          }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key, options) => {
            kvCalls.push({ key, options });
            if (key === "lexical:domain:al7an") {
              return [];
            }
            if (key === "lexical:domain:bible") {
              return [
                {
                  doc_id: "bible-summary:Daniel",
                  chunk_id: "bible-summary:Daniel:1",
                  title: "Daniel",
                  url: "https://example.test/daniel",
                  semanticDomain: "bible",
                  search_text: "three youths fiery furnace hymn song praise",
                  entities: ["three youths"],
                  events: ["fiery furnace"],
                },
              ];
            }
            if (key === "lexical:domain:taqs" || key === "lexical:domain:ta3lim") {
              return [];
            }
            if (key === "lexical:facet:bible-summary-detail" || key === "lexical:metadata") {
              return [];
            }
            if (key === "bible-summary:Daniel:1") {
              return {
                doc_id: "bible-summary:Daniel",
                chunk_id: "bible-summary:Daniel:1",
                title: "Daniel",
                url: "https://example.test/daniel",
                text: "Daniel records the three youths in the fiery furnace praising God.",
                semanticDomain: "bible",
              };
            }
            return null;
          },
        },
      },
      "hymn of the three youths in the furnace",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["bible-summary:Daniel:1"]);
    expect(kvCalls.map((call) => call.key)).toContain("lexical:domain:al7an");
    expect(kvCalls.map((call) => call.key)).toContain("lexical:domain:bible");
  });

  test("does not widen hymn retrieval when hymn candidates exist", async () => {
    const kvCalls: KvCall[] = [];
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_AL7AN_ENABLED: "true",
        ASSISTANT_CHUNKS: {
          get: async (key, options) => {
            kvCalls.push({ key, options });
            if (key === "lexical:domain:al7an") {
              return [
                {
                  doc_id: "al7an:ClosingPrayer",
                  chunk_id: "al7an:ClosingPrayer:0",
                  title: "Closing prayer hymn",
                  url: "https://example.test/hymn",
                  semanticDomain: "al7an",
                  search_text: "closing prayer hymn",
                },
              ];
            }
            if (key === "al7an:ClosingPrayer:0") {
              return {
                doc_id: "al7an:ClosingPrayer",
                chunk_id: "al7an:ClosingPrayer:0",
                title: "Closing prayer hymn",
                url: "https://example.test/hymn",
                text: "A hymn source about the closing prayer hymn.",
                semanticDomain: "al7an",
              };
            }
            return null;
          },
        },
      },
      "closing prayer hymn",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["al7an:ClosingPrayer:0"]);
    expect(kvCalls.map((call) => call.key)).not.toContain("lexical:domain:taqs");
  });
  test("loads the hymn lexical domain for explicit hymn intent while Al7an is quiet", async () => {
    const kvCalls: KvCall[] = [];
    const chunks = await retrieveChunks(
      {
        ASSISTANT_AL7AN_ENABLED: "false",
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_VECTORIZE: {
          query: async () => ({ matches: [] }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key, options) => {
            kvCalls.push({ key, options });
            if (key === "lexical:domain:al7an") {
              return [
                {
                  doc_id: "al7an:Omonogenis",
                  chunk_id: "al7an:Omonogenis:0",
                  title: "أومونوجينيس (أيها الابن الوحيد الجنس)",
                  url: "https://example.test/omonogenis",
                  search_text: "متى يقال لحن أومونوجينيس الساعة السادسة من الجمعة العظيمة",
                  semanticDomain: "al7an",
                },
              ];
            }
            if (key === "al7an:Omonogenis:0") {
              return {
                doc_id: "al7an:Omonogenis",
                chunk_id: "al7an:Omonogenis:0",
                title: "أومونوجينيس (أيها الابن الوحيد الجنس)",
                url: "https://example.test/omonogenis",
                text: "يقال في الساعة السادسة من الجمعة العظيمة.",
                semanticDomain: "al7an",
              };
            }
            return null;
          },
        },
      },
      "لحن أومونوجينيس بيتقال امتى؟",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["al7an:Omonogenis:0"]);
    expect(kvCalls.map((call) => call.key)).toContain("lexical:domain:al7an");
  });

  test("hydrates a strong hymn title alias without opening the whole Al7an domain", async () => {
    const kvCalls: KvCall[] = [];
    const chunks = await retrieveChunks(
      {
        ASSISTANT_AL7AN_ENABLED: "false",
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_VECTORIZE: {
          query: async () => ({ matches: [] }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key, options) => {
            kvCalls.push({ key, options });
            if (key === "lexical:metadata") {
              return [
                {
                  doc_id: "al7an:Omonogenis",
                  chunk_id: "al7an:Omonogenis:0",
                  title: "أومونوجينيس (أيها الابن الوحيد الجنس)",
                  section: "أومونوجينيس (أيها الابن الوحيد الجنس)",
                  url: "https://example.test/omonogenis",
                  keywords: ["لحن أومونوجينيس", "أيها الابن الوحيد الجنس"],
                  semanticDomain: "al7an",
                },
              ];
            }
            if (key === "al7an:Omonogenis:0") {
              return {
                doc_id: "al7an:Omonogenis",
                chunk_id: "al7an:Omonogenis:0",
                title: "أومونوجينيس (أيها الابن الوحيد الجنس)",
                url: "https://example.test/omonogenis",
                text: "يقال في الساعة السادسة من الجمعة العظيمة.",
                semanticDomain: "al7an",
              };
            }
            return null;
          },
        },
      },
      "أومونوجينس بيتقال امتى؟",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["al7an:Omonogenis:0"]);
    expect(kvCalls.map((call) => call.key)).not.toContain("lexical:domain:al7an");
  });

  test("rejects weak Al7an metadata overlap while Al7an is quiet", async () => {
    const chunks = await retrieveChunks(
      {
        ASSISTANT_AL7AN_ENABLED: "false",
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_VECTORIZE: {
          query: async () => ({ matches: [] }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key) => {
            if (key === "lexical:metadata") {
              return [
                {
                  doc_id: "ta2amolat:UnrelatedHymn",
                  chunk_id: "ta2amolat:UnrelatedHymn:0",
                  title: "مديحة برمون الميلاد",
                  url: "https://example.test/unrelated-hymn",
                  summary: "اللحن بيتقال في مناسبة كنسية",
                  semanticDomain: "al7an",
                },
              ];
            }
            if (key === "ta2amolat:UnrelatedHymn:0") {
              return {
                doc_id: "ta2amolat:UnrelatedHymn",
                chunk_id: "ta2amolat:UnrelatedHymn:0",
                title: "مديحة برمون الميلاد",
                url: "https://example.test/unrelated-hymn",
                text: "محتوى لحن آخر غير متعلق بالسؤال.",
                semanticDomain: "al7an",
              };
            }
            return null;
          },
        },
      },
      "ترنيمة غريبة بيتقال امتى؟",
    );

    expect(chunks).toEqual([]);
  });

  test("uses strong metadata matches across routed domain boundaries", async () => {
    const kvCalls: KvCall[] = [];
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async () => ({
            matches: [
              {
                id: "ma3lomat:JesusLifeTimeline:0",
                score: 0.92,
              },
            ],
          }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key, options) => {
            kvCalls.push({ key, options });
            if (key === "lexical:metadata") {
              return [
                {
                  doc_id: "ma3lomat:MothersInChristianity",
                  chunk_id: "ma3lomat:MothersInChristianity:0",
                  title: "أمهات في تاريخ المسيحية",
                  url: "https://example.test/mothers",
                  section: "أمهات في تاريخ المسيحية",
                  summary: "أمثلة من الكتاب المقدس وتاريخ الكنيسة",
                  keywords: ["أمهات من الكتاب المقدس", "الأم في المسيحية"],
                  categories: ["معلومة كتابية"],
                  semanticDomain: "bible",
                  facets: ["bible", "ma3lomat"],
                  library: "معلومات عامة",
                  source_ref: "MothersInChristianity.mdx",
                },
              ];
            }
            if (key === "ma3lomat:MothersInChristianity:0") {
              return {
                doc_id: "ma3lomat:MothersInChristianity",
                chunk_id: "ma3lomat:MothersInChristianity:0",
                title: "أمهات في تاريخ المسيحية",
                url: "https://example.test/mothers",
                text: "Original Mothers in Christianity article.",
                section: "أمهات في تاريخ المسيحية",
                semanticDomain: "bible",
                facets: ["bible", "ma3lomat"],
              };
            }
            if (key === "ma3lomat:JesusLifeTimeline:0") {
              return {
                doc_id: "ma3lomat:JesusLifeTimeline",
                chunk_id: "ma3lomat:JesusLifeTimeline:0",
                title: "بانوراما حياة السيد المسيح من الناحية التاريخية",
                url: "https://example.test/timeline",
                text: "Strong routed history result.",
                semanticDomain: "tari5",
              };
            }
            return null;
          },
        },
      },
      "أمهات في تاريخ المسيحية",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([
      "ma3lomat:MothersInChristianity:0",
    ]);
    expect(kvCalls.map((call) => call.key)).toContain("lexical:metadata");
  });

  test("widens an unclassified proper-name query from a strong metadata match before vector search", async () => {
    const vectorFilters: unknown[] = [];
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async (_vector, options) => {
            vectorFilters.push(options?.filter);
            const domains = (options?.filter as { semanticDomain?: { $in?: string[] } })
              ?.semanticDomain?.$in ?? [];
            return {
              matches: [
                {
                  id: domains.includes("saints")
                    ? "tari5:Arianos:0"
                    : "bible-summary:Acts:0",
                  score: 0.92,
                },
              ],
            };
          },
        },
        ASSISTANT_CHUNKS: {
          get: async (key) => {
            if (key === "lexical:metadata") {
              return [
                {
                  doc_id: "tari5:Arianos",
                  chunk_id: "tari5:Arianos:0",
                  title: "القديس أريانوس والي أنصنا",
                  url: "https://example.test/arianos",
                  keywords: ["القديس أريانوس والي أنصنا"],
                  semanticDomain: "saints",
                  facets: ["history", "saints"],
                },
              ];
            }
            if (key === "lexical:domain:saints") {
              return [];
            }
            if (key === "tari5:Arianos:0") {
              return {
                doc_id: "tari5:Arianos",
                chunk_id: "tari5:Arianos:0",
                title: "القديس أريانوس والي أنصنا",
                url: "https://example.test/arianos",
                text: "تحول الوالي أريانوس إلى الإيمان المسيحي.",
                semanticDomain: "saints",
              };
            }
            if (key === "bible-summary:Acts:0") {
              return {
                doc_id: "bible-summary:Acts",
                chunk_id: "bible-summary:Acts:0",
                title: "أعمال الرسل",
                url: "https://example.test/acts",
                text: "A broad Bible result.",
                semanticDomain: "bible",
              };
            }
            return null;
          },
        },
      },
      "أريانوس",
    );

    expect(vectorFilters).toHaveLength(1);
    expect(vectorFilters[0]).toMatchObject({
      semanticDomain: { $in: expect.arrayContaining(["saints"]) },
    });
    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["tari5:Arianos:0"]);
  });

  test("keeps liturgical authorship in historical-person domains during metadata fusion", async () => {
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async () => ({
            matches: [
              { id: "tari5:KirellosElKebir:0", score: 0.93 },
              { id: "tari5:Tari5CopticEra:0", score: 0.82 },
            ],
          }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key) => {
            if (key === "lexical:domain:tari5") {
              return [
                {
                  doc_id: "tari5:KirellosElKebir",
                  chunk_id: "tari5:KirellosElKebir:0",
                  title: "البابا كيرلس عمود الدين",
                  url: "https://example.test/kirellos",
                  search_text: "أضاف القديس كيرلس صلوات إلى القداس واتسمى القداس الكيرلسي",
                  semanticDomain: "tari5",
                },
                {
                  doc_id: "tari5:Tari5CopticEra",
                  chunk_id: "tari5:Tari5CopticEra:0",
                  title: "الكنيسة في مصر حتى القرن السادس",
                  url: "https://example.test/coptic-era",
                  search_text: "وضع مارمرقس أساس القداس الكيرلسي",
                  semanticDomain: "tari5",
                },
              ];
            }
            if (key === "lexical:domain:saints") {
              return [];
            }
            if (key === "lexical:metadata") {
              return [
                {
                  doc_id: "taqs:Taqdis",
                  chunk_id: "taqs:Taqdis:0",
                  title: "التقديس في القداس الكيرلسي",
                  url: "https://example.test/taqdis",
                  keywords: ["القداس الكيرلسي", "واضع القداس"],
                  semanticDomain: "taqs",
                },
                {
                  doc_id: "tari5:KirellosElKebir",
                  chunk_id: "tari5:KirellosElKebir:0",
                  title: "البابا كيرلس عمود الدين",
                  url: "https://example.test/kirellos",
                  keywords: ["البابا كيرلس الكبير"],
                  semanticDomain: "tari5",
                },
                {
                  doc_id: "tari5:AnbaBasilios",
                  chunk_id: "tari5:AnbaBasilios:0",
                  title: "الأنبا باسيليوس الكبير",
                  url: "https://example.test/basilios",
                  summary: "كاتب أحد القداسات المستعملة في الكنيسة",
                  keywords: ["واضع القداس", "القداس الباسيلي"],
                  semanticDomain: "saints",
                },
              ];
            }
            if (key === "tari5:KirellosElKebir:0") {
              return {
                doc_id: "tari5:KirellosElKebir",
                chunk_id: "tari5:KirellosElKebir:0",
                title: "البابا كيرلس عمود الدين",
                url: "https://example.test/kirellos",
                text: "أضاف القديس كيرلس صلوات إلى قداس مارمرقس فاتسمى القداس الكيرلسي.",
                semanticDomain: "tari5",
              };
            }
            if (key === "tari5:Tari5CopticEra:0") {
              return {
                doc_id: "tari5:Tari5CopticEra",
                chunk_id: "tari5:Tari5CopticEra:0",
                title: "الكنيسة في مصر حتى القرن السادس",
                url: "https://example.test/coptic-era",
                text: "وضع مارمرقس أساس القداس الكيرلسي.",
                semanticDomain: "tari5",
              };
            }
            if (key === "tari5:AnbaBasilios:0") {
              return {
                doc_id: "tari5:AnbaBasilios",
                chunk_id: "tari5:AnbaBasilios:0",
                title: "الأنبا باسيليوس الكبير",
                url: "https://example.test/basilios",
                text: "كتب القداس الباسيلي.",
                semanticDomain: "saints",
              };
            }
            if (key === "taqs:Taqdis:0") {
              return {
                doc_id: "taqs:Taqdis",
                chunk_id: "taqs:Taqdis:0",
                title: "التقديس في القداس الكيرلسي",
                url: "https://example.test/taqdis",
                text: "ترتيب التقديس في القداس.",
                semanticDomain: "taqs",
              };
            }
            return null;
          },
        },
      },
      "مين واضع القداس الكيرلسي؟",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["tari5:KirellosElKebir:0"]);
  });

  test("uses metadata keywords when routed results are weak", async () => {
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async () => ({
            matches: [
              {
                id: "ma3lomat:Samaka:0",
                score: 0.55,
              },
            ],
          }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key) => {
            if (key === "lexical:metadata") {
              return [
                {
                  doc_id: "ma3lomat:MothersInChristianity",
                  chunk_id: "ma3lomat:MothersInChristianity:0",
                  title: "أمهات في تاريخ المسيحية",
                  url: "https://example.test/mothers",
                  summary: "أمثلة من الكتاب المقدس وتاريخ الكنيسة",
                  keywords: ["أمهات من الكتاب المقدس", "الأم في المسيحية", "مقالات مسيحية في عيد الأم"],
                  categories: ["معلومة كتابية"],
                  semanticDomain: "bible",
                  facets: ["bible", "ma3lomat"],
                },
              ];
            }
            if (key === "ma3lomat:MothersInChristianity:0") {
              return {
                doc_id: "ma3lomat:MothersInChristianity",
                chunk_id: "ma3lomat:MothersInChristianity:0",
                title: "أمهات في تاريخ المسيحية",
                url: "https://example.test/mothers",
                text: "Original Mothers in Christianity article.",
                semanticDomain: "bible",
              };
            }
            if (key === "ma3lomat:Samaka:0") {
              return {
                doc_id: "ma3lomat:Samaka",
                chunk_id: "ma3lomat:Samaka:0",
                title: "السمكة",
                url: "https://example.test/fish",
                text: "Weak vector result.",
                semanticDomain: "tari5",
              };
            }
            return null;
          },
        },
      },
      "مقالات مسيحية في عيد الأم",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([
      "ma3lomat:MothersInChristianity:0",
    ]);
  });

  test("does not let weak metadata overlap displace a strong routed result", async () => {
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async () => ({
            matches: [
              {
                id: "ma3lomat:JesusLifeTimeline:0",
                score: 0.93,
              },
            ],
          }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key) => {
            if (key === "lexical:metadata") {
              return [
                {
                  doc_id: "ma3lomat:MothersInChristianity",
                  chunk_id: "ma3lomat:MothersInChristianity:0",
                  title: "أمهات في تاريخ المسيحية",
                  url: "https://example.test/mothers",
                  summary: "أمثلة من الكتاب المقدس وتاريخ الكنيسة",
                  keywords: ["الأم في المسيحية"],
                  categories: ["معلومة كتابية"],
                  semanticDomain: "bible",
                  facets: ["bible", "ma3lomat"],
                },
              ];
            }
            if (key === "ma3lomat:JesusLifeTimeline:0") {
              return {
                doc_id: "ma3lomat:JesusLifeTimeline",
                chunk_id: "ma3lomat:JesusLifeTimeline:0",
                title: "بانوراما حياة السيد المسيح من الناحية التاريخية",
                url: "https://example.test/timeline",
                text: "Strong routed history result.",
                semanticDomain: "tari5",
              };
            }
            if (key === "ma3lomat:MothersInChristianity:0") {
              return {
                doc_id: "ma3lomat:MothersInChristianity",
                chunk_id: "ma3lomat:MothersInChristianity:0",
                title: "أمهات في تاريخ المسيحية",
                url: "https://example.test/mothers",
                text: "Original Mothers in Christianity article.",
                semanticDomain: "bible",
              };
            }
            return null;
          },
        },
      },
      "تاريخ المسيح",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([
      "ma3lomat:JesusLifeTimeline:0",
    ]);
  });
  test("loads default domain shards for no-domain teaching fallback", async () => {
    const kvCalls: KvCall[] = [];
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async () => ({
            matches: [
              {
                id: "bible-summary:Ecclesiastes:0",
                score: 0.94,
              },
            ],
          }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key, options) => {
            kvCalls.push({ key, options });
            if (key === "lexical:domain:ta3lim") {
              return [
                {
                  ...lookupChunks["wa3zat:ElTariqElDa5ely:0"],
                  search_text: "repentance heart",
                  keywords: ["repentance"],
                },
              ];
            }
            if (key === "lexical:domain:bible") {
              return [
                {
                  doc_id: "bible-summary:Ecclesiastes",
                  chunk_id: "bible-summary:Ecclesiastes:0",
                  title: "Ecclesiastes",
                  url: "https://example.test/ecclesiastes",
                  semanticDomain: "bible",
                  search_text: "wisdom",
                },
              ];
            }
            if (key === "bible-summary:Ecclesiastes:0") {
              return {
                doc_id: "bible-summary:Ecclesiastes",
                chunk_id: "bible-summary:Ecclesiastes:0",
                title: "Ecclesiastes",
                url: "https://example.test/ecclesiastes",
                text: "Vector-only related wisdom result.",
                search_text: "wisdom",
              };
            }
            return lookupChunks[key] ?? null;
          },
        },
      },
      "repentance heart",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["wa3zat:ElTariqElDa5ely:0"]);
    expect(kvCalls.map((call) => call.key)).toContain("lexical:domain:ta3lim");
    expect(kvCalls.map((call) => call.key)).toContain("lexical:domain:bible");
  });

  test("uses domain search text as a focused backstop for no-domain sermon queries", async () => {
    const kvCalls: KvCall[] = [];
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async () => ({
            matches: [
              {
                id: "wa3zat:Ef5arestia:0",
                score: 0.99,
              },
            ],
          }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key, options) => {
            kvCalls.push({ key, options });
            if (key === "lexical:domain:ta3lim") {
              return [];
            }
            if (key === "lexical:domain:bible") {
              return [
                {
                  doc_id: "wa3zat:E7batElijah",
                  chunk_id: "wa3zat:E7batElijah:0",
                  title: "Elijah discouragement",
                  url: "https://example.test/e7bat-elijah",
                  semanticDomain: "bible",
                  facets: ["bible", "sermon"],
                  search_text: "elijah discouragement after victory over prophets of baal",
                  summary: "discouragement after victory over prophets of Baal",
                  keywords: ["elijah", "discouragement", "victory"],
                },
              ];
            }
            if (key === "lexical:facet:sermon") {
              return [
                {
                  doc_id: "wa3zat:E7batElijah",
                  chunk_id: "wa3zat:E7batElijah:0",
                  title: "Elijah discouragement",
                  url: "https://example.test/e7bat-elijah",
                  semanticDomain: "bible",
                  facets: ["bible", "sermon"],
                  summary: "discouragement after victory over prophets of Baal",
                  keywords: ["elijah", "discouragement", "victory"],
                },
              ];
            }
            if (key === "wa3zat:E7batElijah:0") {
              return {
                doc_id: "wa3zat:E7batElijah",
                chunk_id: "wa3zat:E7batElijah:0",
                title: "Elijah discouragement",
                url: "https://example.test/e7bat-elijah",
                text: "Original sermon text.",
                semanticDomain: "bible",
                facets: ["bible", "sermon"],
              };
            }
            return lookupChunks[key] ?? null;
          },
        },
      },
      "elijah discouragement after victory",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["wa3zat:E7batElijah:0"]);
    expect(kvCalls.map((call) => call.key)).toContain("lexical:domain:bible");
  });

  test("uses Bible detail overlay for broad person lookup questions", async () => {
    const kvCalls: KvCall[] = [];
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async () => ({
            matches: [
              {
                id: "bible-summary:Matthew:3",
                score: 0.98,
              },
            ],
          }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key, options) => {
            kvCalls.push({ key, options });
            if (key === "lexical:domain:bible") {
              return [];
            }
            if (key === "lexical:facet:bible-summary-detail") {
              return [
                {
                  doc_id: "bible-summary:Judges",
                  chunk_id: "bible-summary:Judges:1",
                  title: "Judges",
                  url: "https://example.test/judges",
                  semanticDomain: "bible",
                  content_type: "bible_summary",
                  entities: ["يفتاح", "دبورة"],
                  detail_search_text: "القضاة",
                },
              ];
            }
            if (key === "bible-summary:Judges:1") {
              return {
                doc_id: "bible-summary:Judges",
                chunk_id: "bible-summary:Judges:1",
                title: "Judges",
                url: "https://example.test/judges",
                text: "Judges detail text.",
                semanticDomain: "bible",
                content_type: "bible_summary",
              };
            }
            if (key === "bible-summary:Matthew:3") {
              return {
                doc_id: "bible-summary:Matthew",
                chunk_id: "bible-summary:Matthew:3",
                title: "Matthew",
                url: "https://example.test/matthew",
                text: "Vector miss.",
                semanticDomain: "bible",
                content_type: "bible_summary",
              };
            }
            return lookupChunks[key] ?? null;
          },
        },
      },
      "ايه اللي حصل مع يفتاح",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["bible-summary:Judges:1"]);
    expect(kvCalls.map((call) => call.key)).toContain("lexical:facet:bible-summary-detail");
  });

  test("matches Arabic terms when the query attaches a prefix before the article", async () => {
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_CHUNKS: {
          get: async (key) => {
            if (key === "lexical:domain:ta3lim") {
              return [
                {
                  ...lookupChunks["wa3zat:ElTariqElDa5ely:0"],
                  search_text: "النوس وتجديد الذهن في الحياة الروحية",
                },
              ];
            }
            return lookupChunks[key] ?? null;
          },
        },
      },
      "ما المقصود بالنوس",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["wa3zat:ElTariqElDa5ely:0"]);
  });

  test("uses the small teaching lexical shard as a backstop for high-score vector misses", async () => {
    const kvCalls: KvCall[] = [];
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async () => ({
            matches: [
              {
                id: "wa3zat:Ef5arestia:0",
                score: 0.99,
              },
            ],
          }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key, options) => {
            kvCalls.push({ key, options });
            if (key === "lexical:domain:ta3lim") {
              return [
                {
                  ...lookupChunks["wa3zat:ElTariqElDa5ely:0"],
                  search_text: "repentance heart renewing mind",
                  keywords: ["repentance", "heart"],
                },
              ];
            }
            return lookupChunks[key] ?? null;
          },
        },
      },
      "repentance heart",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["wa3zat:ElTariqElDa5ely:0"]);
    expect(kvCalls.map((call) => call.key)).toContain("lexical:domain:ta3lim");
  });

  test("filters vector search by routed semantic domains", async () => {
    const queryOptions: unknown[] = [];
    await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async (_vector, options) => {
            queryOptions.push(options);
            return { matches: [] };
          },
        },
        ASSISTANT_CHUNKS: {
          get: async () => null,
        },
      },
      "genesis covenant",
    );

    expect(queryOptions[0]).toMatchObject({
      filter: {
        semanticDomain: { $in: ["bible", "ta3lim"] },
        source_library: { $nin: ["about", "aqwal", "cartoon", "coptic", "seneksar"] },
      },
    });
  });

  test("selects the current Seneksar day for relative-date questions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T10:00:00Z"));
    try {
      const requestedKeys: string[] = [];
      const chunks = await retrieveChunks(
        {
          RETRIEVAL_TOP_K: "1",
          RETRIEVAL_CANDIDATE_K: "10",
          ASSISTANT_SENEKSAR_ENABLED: "true",
          ASSISTANT_LEXICAL_KEYS: "lexical:domain",
          ASSISTANT_CHUNKS: {
            get: async (key) => {
              requestedKeys.push(key);
              if (key === "lexical:metadata") {
                return [
                  {
                    doc_id: "seneksar:day-197",
                    chunk_id: "seneksar:day-197:0",
                    title: "9 أبيب",
                    url: "https://example.test/Seneksar.php?q=197",
                    source_library: "seneksar",
                    semanticDomain: "saints",
                    keywords: ["seneksar-date:07-16"],
                  },
                  {
                    doc_id: "seneksar:day-198",
                    chunk_id: "seneksar:day-198:0",
                    title: "10 أبيب",
                    url: "https://example.test/Seneksar.php?q=198",
                    source_library: "seneksar",
                    semanticDomain: "saints",
                    keywords: ["seneksar-date:07-17"],
                  },
                ];
              }
              if (key.startsWith("lexical:")) return [];
              if (key === "seneksar:day-197:0") {
                return {
                  doc_id: "seneksar:day-197",
                  chunk_id: key,
                  title: "9 أبيب",
                  url: "https://example.test/Seneksar.php?q=197",
                  text: "تذكارات سنكسار اليوم.",
                  source_library: "seneksar",
                  semanticDomain: "saints",
                };
              }
              return null;
            },
          },
        },
        "إيه سنكسار النهاردة؟",
      );
      expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["seneksar:day-197:0"]);
      expect(requestedKeys).not.toContain("lexical:metadata:seneksar");
    } finally {
      vi.useRealTimers();
    }
  });
  test("retrieves a strong Seneksar commemoration alias while the library is quiet", async () => {
    const chunkId = "seneksar:day-121:0";
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
        ASSISTANT_VECTORIZE: {
          query: async () => ({ matches: [{ id: "taqs:vector:0", score: 0.91 }] }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key) => {
            if (key === "taqs:vector:0") {
              return {
                doc_id: "taqs:vector",
                chunk_id: key,
                title: "Vector distractor",
                url: "https://example.test/taqs/vector",
                text: "A vector-only distractor.",
                source_library: "taqs",
                semanticDomain: "taqs",
              };
            }
            if (key === "lexical:metadata") {
              return [{
                doc_id: "seneksar:day-121",
                chunk_id: chunkId,
                title: "23 برموده",
                section: "23 برموده",
                summary: "شهادة القديس جورجيوس العظيم في الشهداء",
                keywords: [
                  "seneksar-date:05-01",
                  "شهادة القديس جورجيوس العظيم في الشهداء",
                ],
                url: "https://example.test/Seneksar.php?q=121",
                source_library: "seneksar",
                semanticDomain: "saints",
                facets: ["saints"],
              }];
            }
            if (key === chunkId) {
              return {
                doc_id: "seneksar:day-121",
                chunk_id: chunkId,
                title: "23 برموده",
                url: "https://example.test/Seneksar.php?q=121",
                text: "في مثل هذا اليوم استشهد القديس جورجيوس (مارجرجس).",
                source_library: "seneksar",
                semanticDomain: "saints",
              };
            }
            if (key.startsWith("lexical:")) return [];
            return null;
          },
        },
      },
      "امتى عيد استشهاد مارجرجس؟",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([chunkId]);
  });

  test.each([
    { source: "aqwal", domain: "ta3lim", title: "الأنبا أغاثون المتوحد" },
    { source: "coptic", domain: "coptic", title: "أدوات الإضافة في القبطي" },
    { source: "about", domain: "school", title: "الكتب والمناهج" },
    { source: "cartoon", domain: "bible", title: "داود يسامح شاول" },
    { source: "seneksar", domain: "saints", title: "نياحة القديس يوحنا أسقف أورشليم" },
  ])("hydrates an exact $source metadata title while the library is quiet", async ({
    source,
    domain,
    title,
  }) => {
    const chunkId = `${source}:exact:0`;
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_VECTORIZE: { query: async () => ({ matches: [] }) },
        ASSISTANT_CHUNKS: {
          get: async (key) => {
            if (key === "lexical:metadata") {
              return [{
                doc_id: `${source}:exact`,
                chunk_id: chunkId,
                title,
                section: title,
                url: `https://example.test/${source}/exact`,
                source_library: source,
                semanticDomain: domain,
              }];
            }
            if (key === chunkId) {
              return {
                doc_id: `${source}:exact`,
                chunk_id: chunkId,
                title,
                url: `https://example.test/${source}/exact`,
                text: `Source-backed content for ${title}.`,
                source_library: source,
                semanticDomain: domain,
              };
            }
            if (key.startsWith("lexical:")) return [];
            return null;
          },
        },
      },
      title,
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([chunkId]);
  });

  test.each([
    { source: "aqwal", domain: "ta3lim", query: "قول غير موجود", overlap: "قول" },
    { source: "coptic", domain: "coptic", query: "قواعد غير موجودة", overlap: "قواعد" },
    { source: "about", domain: "school", query: "مدرسة مجهولة", overlap: "مدرسة" },
    { source: "cartoon", domain: "bible", query: "كارتون غير موجود", overlap: "كارتون" },
    { source: "seneksar", domain: "saints", query: "قديس غير موجود", overlap: "قديس" },
  ])("rejects weak $source metadata overlap while the library is quiet", async ({
    source,
    domain,
    query,
    overlap,
  }) => {
    const chunkId = `${source}:weak:0`;
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_VECTORIZE: { query: async () => ({ matches: [] }) },
        ASSISTANT_CHUNKS: {
          get: async (key) => {
            if (key === "lexical:metadata") {
              return [{
                doc_id: `${source}:weak`,
                chunk_id: chunkId,
                title: "موضوع مختلف",
                section: "موضوع مختلف",
                summary: overlap,
                keywords: [overlap],
                url: `https://example.test/${source}/weak`,
                source_library: source,
                semanticDomain: domain,
              }];
            }
            if (key === chunkId) {
              return {
                doc_id: `${source}:weak`,
                chunk_id: chunkId,
                title: "موضوع مختلف",
                url: `https://example.test/${source}/weak`,
                text: "Unrelated source-backed content.",
                source_library: source,
                semanticDomain: domain,
              };
            }
            if (key.startsWith("lexical:")) return [];
            return null;
          },
        },
      },
      query,
    );

    expect(chunks).toEqual([]);
  });
  test("only admits cartoon vectors and lexical overlays for explicit cartoon intent", async () => {
    const queryOptions: unknown[] = [];
    const requestedKeys: string[] = [];
    await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_CARTOON_ENABLED: "true",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
        ASSISTANT_VECTORIZE: {
          query: async (_vector, options) => {
            queryOptions.push(options);
            return { matches: [] };
          },
        },
        ASSISTANT_CHUNKS: {
          get: async (key) => {
            requestedKeys.push(key);
            return [];
          },
        },
      },
      "cartoon about the good samaritan",
    );
    expect(queryOptions[0]).toMatchObject({
      filter: {
        source_library: { $nin: ["about", "aqwal", "coptic", "seneksar"] },
      },
    });
    expect(requestedKeys).toContain("lexical:facet:cartoon");
    expect(requestedKeys).toContain("lexical:metadata");
    expect(requestedKeys).not.toContain("lexical:metadata:cartoon");
  });
  test("matches Arabic title tokens with leading article variants", async () => {
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async () => ({
            matches: [
              {
                id: "bible-summary:Acts:0",
                score: 0.99,
              },
            ],
          }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key) => {
            if (key === "lexical:domain:bible") {
              return [
                {
                  doc_id: "bible-summary:Deuteronomy",
                  chunk_id: "bible-summary:Deuteronomy:0",
                  title: "تثنية",
                  url: "https://madraset-elshamamsa.com/articles/Ketab/Deuteronomy.php",
                  content_type: "bible_summary",
                  library: "ملخص الكتاب المقدس",
                  section: "تثنية",
                  language: "ar",
                  semanticDomain: "bible",
                  facets: ["bible"],
                  summary: "الوصية والعهد قبل دخول ارض الموعد",
                  keywords: ["سفر التثنية"],
                },
              ];
            }

            if (key === "bible-summary:Deuteronomy:0") {
              return {
                doc_id: "bible-summary:Deuteronomy",
                chunk_id: "bible-summary:Deuteronomy:0",
                title: "تثنية",
                url: "https://madraset-elshamamsa.com/articles/Ketab/Deuteronomy.php",
                text: "ملخص سفر التثنية.",
                search_text: "تثنيه الوصيه العهد",
                content_type: "bible_summary",
                library: "ملخص الكتاب المقدس",
                section: "تثنية",
                language: "ar",
              };
            }

            if (key === "bible-summary:Acts:0") {
              return {
                doc_id: "bible-summary:Acts",
                chunk_id: "bible-summary:Acts:0",
                title: "أعمال الرسل",
                url: "https://madraset-elshamamsa.com/articles/Ketab/Acts.php",
                text: "ملخص سفر اعمال الرسل.",
                search_text: "اعمال الرسل",
                content_type: "bible_summary",
                library: "ملخص الكتاب المقدس",
                section: "أعمال الرسل",
                language: "ar",
              };
            }

            return null;
          },
        },
      },
      "ما فكرة سفر التثنية عن الوصية والعهد؟",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([
      "bible-summary:Deuteronomy:0",
    ]);
  });

  test("prioritizes lexical title matches over vector-only related chunks", async () => {
    const env: Env = {
      RETRIEVAL_TOP_K: "2",
      RETRIEVAL_CANDIDATE_K: "10",
      ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
      ASSISTANT_AI: {
        run: async () => ({
          data: [[0.1, 0.2, 0.3]],
        }),
      },
      ASSISTANT_VECTORIZE: {
        query: async () => ({
          matches: [
            {
              id: "wa3zat:ElTariqElDa5ely:11",
              score: 0.99,
            },
            {
              id: "wa3zat:ElTariqElDa5ely:0",
              score: 0.5,
            },
          ],
        }),
      },
      ASSISTANT_CHUNKS: {
        get: async (key) => {
          if (key === "lexical:wa3zat") {
            return [
              lookupChunks["wa3zat:ElTariqElDa5ely:0"],
              {
                ...lookupChunks["wa3zat:ElTariqElDa5ely:0"],
                chunk_id: "wa3zat:ElTariqElDa5ely:11",
                section: "التوبة",
                search_text: "التوبه الميطانيا تغيير الذهن",
              },
            ];
          }

          if (key === "wa3zat:ElTariqElDa5ely:11") {
            return {
              ...lookupChunks["wa3zat:ElTariqElDa5ely:0"],
              chunk_id: "wa3zat:ElTariqElDa5ely:11",
              section: "التوبة",
            };
          }

          return lookupChunks[key] ?? null;
        },
      },
    };

    const chunks = await retrieveChunks(env, "الطريق الداخلي");

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([
      "wa3zat:ElTariqElDa5ely:0",
      "wa3zat:ElTariqElDa5ely:11",
    ]);
  });

  test("ranks the intro chunk first for broad title queries", async () => {
    const env = createLexicalOnlyEnv([
      {
        doc_id: "doc:internal-path",
        chunk_id: "doc:internal-path:11",
        title: "internal path",
        url: "https://example.test/internal-path",
        text: "Repentance changes the internal path by returning the heart to God.",
        search_text: "repentance internal path internal heart path change",
        section: "repentance",
        language: "en",
      },
      {
        doc_id: "doc:internal-path",
        chunk_id: "doc:internal-path:0",
        title: "internal path",
        url: "https://example.test/internal-path",
        text: "The internal path starts with the heart, not only external behavior.",
        search_text: "internal path heart external behavior",
        section: "intro",
        language: "en",
      },
    ]);

    const chunks = await retrieveChunks(env, "internal path");

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([
      "doc:internal-path:0",
      "doc:internal-path:11",
    ]);
  });

  test("keeps the specific section first when the query names that section", async () => {
    const env = createLexicalOnlyEnv([
      {
        doc_id: "doc:internal-path",
        chunk_id: "doc:internal-path:0",
        title: "internal path",
        url: "https://example.test/internal-path",
        text: "The internal path starts with the heart, not only external behavior.",
        search_text: "internal path heart external behavior",
        section: "intro",
        language: "en",
      },
      {
        doc_id: "doc:internal-path",
        chunk_id: "doc:internal-path:11",
        title: "internal path",
        url: "https://example.test/internal-path",
        text: "Repentance changes the internal path by returning the heart to God.",
        search_text: "repentance internal path internal heart path change",
        section: "repentance",
        language: "en",
      },
    ]);

    const chunks = await retrieveChunks(env, "repentance internal path");

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([
      "doc:internal-path:11",
      "doc:internal-path:0",
    ]);
  });

  test("matches lexical metadata when body text does not contain the query", async () => {
    const env = createLexicalOnlyEnv([
      {
        doc_id: "wa3zat:NativityLight",
        chunk_id: "wa3zat:NativityLight:0",
        title: "نور تجسده الطاهر",
        url: "https://madraset-elshamamsa.com/articles/wa3zat/NativityLight.php",
        text: "Body text about incarnation without repeating the metadata term.",
        search_text: "body text about incarnation without repeating the metadata term",
        section: "intro",
        language: "en",
        categories: ["الميلاد"],
        keywords: ["عيد الميلاد"],
        authors: ["أبونا اختبار"],
        summary: "وعظة عن سر التجسد",
      },
    ]);

    const chunks = await retrieveChunks(env, "الميلاد");

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([
      "wa3zat:NativityLight:0",
    ]);
    expect(chunks[0]).not.toHaveProperty("search_text");
  });

  test("matches source-backed enriched lexical fields without full text", async () => {
    const env = createLexicalOnlyEnv([
      {
        doc_id: "bible-summary:Genesis",
        chunk_id: "bible-summary:Genesis:2",
        title: "تكوين",
        url: "https://madraset-elshamamsa.com/articles/Ketab/Genesis.php",
        text: "Hydrated original text about Abraham and Isaac.",
        section: "العهد مع إبراهيم",
        language: "ar",
        semanticDomain: "bible",
        entities: ["إبراهيم", "إسحاق"],
        events: ["ذبح إسحاق"],
        symbols: ["نسل المرأة", "رأس الحية"],
        themes: ["الخلاص"],
        aliases: ["اسحق"],
        enriched_terms: ["ذبح إسحاق", "اسحق"],
      },
    ]);

    const chunks = await retrieveChunks(
      env,
      "إيه اللي ذكر عن حادثة ذبح إسحق في الكتاب المقدس؟",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([
      "bible-summary:Genesis:2",
    ]);
  });

  test("matches curated biblical name aliases in enriched lexical fields", async () => {
    const env = createLexicalOnlyEnv([
      {
        doc_id: "bible-summary:Genesis",
        chunk_id: "bible-summary:Genesis:2",
        title: "تكوين",
        url: "https://madraset-elshamamsa.com/articles/Ketab/Genesis.php",
        text: "استقبله ملكي صادق بالخبز والخمر وباركه.",
        section: "العهد مع إبراهيم",
        language: "ar",
        semanticDomain: "bible",
        entities: ["ملكي صادق"],
      },
    ]);

    const chunks = await retrieveChunks(
      env,
      "مين هو ملشيصادق؟ و أين ذُكِر في الكتاب المقدس؟",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([
      "bible-summary:Genesis:2",
    ]);
  });

  test("loads the verse lexical shard for verse-like reference queries", async () => {
    const kvCalls: KvCall[] = [];
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_CHUNKS: {
          get: async (key, options) => {
            kvCalls.push({ key, options });
            if (key === "lexical:domain:bible") {
              return [];
            }
            if (key === "lexical:facet:bible-summary-detail") {
              return [];
            }
            if (key === "lexical:facet:verse") {
              return [
                {
                  doc_id: "verse:verse-7",
                  chunk_id: "verse:verse-7:0",
                  title: "John 3 : 16",
                  url: "https://madraset-elshamamsa.com/generateVerse.php?id=7",
                  content_type: "verse",
                  library: "Verse Reflections",
                  section: "John 3 : 16",
                  language: "en",
                  semanticDomain: "bible",
                  facets: ["bible", "verse"],
                  search_text: "john 3 16 for god so loved the world",
                  summary: "for god so loved the world",
                },
              ];
            }
            if (key === "verse:verse-7:0") {
              return {
                doc_id: "verse:verse-7",
                chunk_id: "verse:verse-7:0",
                title: "John 3 : 16",
                url: "https://madraset-elshamamsa.com/generateVerse.php?id=7",
                text: "For God so loved the world.",
                search_text: "john 3 16 for god so loved the world",
                content_type: "verse",
                library: "Verse Reflections",
                section: "John 3 : 16",
                language: "en",
                semanticDomain: "bible",
                facets: ["bible", "verse"],
              };
            }
            return null;
          },
        },
      },
      "where is the verse John 3 16",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["verse:verse-7:0"]);
    expect(chunks[0]).not.toHaveProperty("search_text");
    expect(kvCalls.map((call) => call.key)).toContain("lexical:facet:verse");
  });

  test("prefers lexical chunks that cover more distinct query terms", async () => {
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_CHUNKS: {
          get: async (key) => {
            if (key === "lexical:domain:ta3lim") {
              return [
                {
                  doc_id: "ma3lomat:ApostlesPreach",
                  chunk_id: "ma3lomat:ApostlesPreach:0",
                  title: "انتشار الكرازة في زمن الرسل",
                  url: "https://example.test/apostles-preach",
                  semanticDomain: "ta3lim",
                  search_text: "فرنسا القديس لوقا الرسول بشر وكرز في بلاد الغال",
                },
                {
                  doc_id: "ma3lomat:BoulesRe7la1",
                  chunk_id: "ma3lomat:BoulesRe7la1:0",
                  title: "رحلة القديس بولس الرسول التبشيرية الأولى",
                  url: "https://example.test/paul-journey",
                  semanticDomain: "bible",
                  search_text: "القديس بولس الرسول من اعظم الرسل والمبشرين في تاريخ الكنيسة",
                },
              ];
            }
            if (key === "lexical:domain:bible" || key === "lexical:domain:taqs") {
              return [];
            }
            if (key === "ma3lomat:ApostlesPreach:0") {
              return {
                doc_id: "ma3lomat:ApostlesPreach",
                chunk_id: "ma3lomat:ApostlesPreach:0",
                title: "انتشار الكرازة في زمن الرسل",
                url: "https://example.test/apostles-preach",
                text: "في فرنسا كرز القديس لوقا الرسول.",
                semanticDomain: "ta3lim",
              };
            }
            if (key === "ma3lomat:BoulesRe7la1:0") {
              return {
                doc_id: "ma3lomat:BoulesRe7la1",
                chunk_id: "ma3lomat:BoulesRe7la1:0",
                title: "رحلة القديس بولس الرسول التبشيرية الأولى",
                url: "https://example.test/paul-journey",
                text: "مقدمة عامة عن رحلات بولس الرسول.",
                semanticDomain: "bible",
              };
            }
            return null;
          },
        },
      },
      "مين الرسول اللي بشر في فرنسا؟",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["ma3lomat:ApostlesPreach:0"]);
  });

  test("preserves strong structured Bible lexical candidates over broad vector matches", async () => {
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async () => ({
            matches: [
              {
                id: "ma3lomat:BroadMissionary:0",
                score: 0.91,
              },
            ],
          }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key) => {
            if (key === "lexical:domain:ta3lim" || key === "lexical:domain:taqs") {
              return [];
            }
            if (key === "lexical:domain:bible") {
              return [
                {
                  doc_id: "bible-summary:Acts",
                  chunk_id: "bible-summary:Acts:2",
                  title: "أعمال الرسل",
                  url: "https://madraset-elshamamsa.com/articles/Ketab/Acts.php",
                  semanticDomain: "bible",
                  content_type: "bible_summary",
                  search_text: "اول مبشر في السامره فيلبس الشماس بشر في السامره",
                  places: ["السامرة"],
                  entities: ["فيلبس الشماس"],
                  events: ["الكرازة في السامرة"],
                },
              ];
            }
            if (key === "lexical:facet:bible-summary-detail") {
              return [];
            }
            if (key === "lexical:metadata") {
              return [];
            }
            if (key === "ma3lomat:BroadMissionary:0") {
              return {
                doc_id: "ma3lomat:BroadMissionary",
                chunk_id: "ma3lomat:BroadMissionary:0",
                title: "انتشار الكرازة",
                url: "https://example.test/missionary",
                text: "مقال عام عن المبشرين والكرازة في زمن الرسل.",
                semanticDomain: "ta3lim",
                content_type: "article",
              };
            }
            if (key === "bible-summary:Acts:2") {
              return {
                doc_id: "bible-summary:Acts",
                chunk_id: "bible-summary:Acts:2",
                title: "أعمال الرسل",
                url: "https://madraset-elshamamsa.com/articles/Ketab/Acts.php",
                text: "فيلبس الشماس المبشر راح وبشر في السامرة.",
                semanticDomain: "bible",
                content_type: "bible_summary",
              };
            }
            return null;
          },
        },
      },
      "مين أول مبشر في السامرة؟",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["bible-summary:Acts:2"]);
  });
  test("keeps top vector Ma3lomat candidate when broad Bible lexical fallback also matches", async () => {
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "2",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async () => ({
            matches: [
              {
                id: "ma3lomat:ApostlesPreach:0",
                score: 0.55,
              },
              {
                id: "bible-summary:Acts:0",
                score: 0.54,
              },
            ],
          }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key) => {
            if (key === "lexical:domain:ta3lim" || key === "lexical:domain:taqs") {
              return [];
            }
            if (key === "lexical:domain:bible") {
              return [
                {
                  doc_id: "bible-summary:Acts",
                  chunk_id: "bible-summary:Acts:0",
                  title: "أعمال الرسل",
                  url: "https://madraset-elshamamsa.com/articles/Ketab/Acts.php",
                  semanticDomain: "bible",
                  content_type: "bible_summary",
                  search_text: "الرسول بشر فرنسا في اعمال الرسل بولس كرازه",
                },
              ];
            }
            if (key === "lexical:facet:bible-summary-detail") {
              return [];
            }
            if (key === "lexical:metadata") {
              return [
                {
                  doc_id: "bible-summary:Acts",
                  chunk_id: "bible-summary:Acts:0",
                  title: "أعمال الرسل",
                  url: "https://madraset-elshamamsa.com/articles/Ketab/Acts.php",
                  semanticDomain: "bible",
                  content_type: "bible_summary",
                  search_text: "الرسول بشر فرنسا في اعمال الرسل بولس كرازه",
                },
              ];
            }
            if (key === "ma3lomat:ApostlesPreach:0") {
              return {
                doc_id: "ma3lomat:ApostlesPreach",
                chunk_id: "ma3lomat:ApostlesPreach:0",
                title: "انتشار الكرازة في زمن الرسل",
                url: "https://example.test/apostles-preach",
                text: "كرز فيلبس الرسول في بلاد الغال التي تشمل فرنسا.",
                semanticDomain: "ta3lim",
                content_type: "article",
              };
            }
            if (key === "bible-summary:Acts:0") {
              return {
                doc_id: "bible-summary:Acts",
                chunk_id: "bible-summary:Acts:0",
                title: "أعمال الرسل",
                url: "https://madraset-elshamamsa.com/articles/Ketab/Acts.php",
                text: "ملخص عام لسفر أعمال الرسل.",
                semanticDomain: "bible",
                content_type: "bible_summary",
              };
            }
            return null;
          },
        },
      },
      "مين الرسول اللي بشر في فرنسا؟",
    );

    expect(chunks[0]?.chunk_id).toBe("ma3lomat:ApostlesPreach:0");
  });
  test("promotes Bible body phrase matches from domain search text over vector misses", async () => {
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({
            data: [[0.1, 0.2, 0.3]],
          }),
        },
        ASSISTANT_VECTORIZE: {
          query: async () => ({
            matches: [
              {
                id: "bible-summary:Genesis:0",
                score: 0.98,
              },
            ],
          }),
        },
        ASSISTANT_CHUNKS: {
          get: async (key) => {
            if (key === "lexical:domain:ta3lim" || key === "lexical:domain:taqs") {
              return [];
            }
            if (key === "lexical:domain:bible") {
              return [
                {
                  doc_id: "bible-summary:Genesis",
                  chunk_id: "bible-summary:Genesis:0",
                  title: "تكوين",
                  url: "https://madraset-elshamamsa.com/articles/Ketab/Genesis.php",
                  semanticDomain: "bible",
                  content_type: "bible_summary",
                  search_text: "تكوين الخليقه والسقوط وبدايه خلقه العالم",
                },
                {
                  doc_id: "bible-summary:John",
                  chunk_id: "bible-summary:John:1",
                  title: "يوحنا",
                  url: "https://madraset-elshamamsa.com/articles/Ketab/John.php",
                  semanticDomain: "bible",
                  content_type: "bible_summary",
                  search_text:
                    "في البدء كان الكلمه والكلمه كان عند الله وكان الكلمه الله يوحنا 1 1 ازليه الابن",
                },
              ];
            }
            if (key === "lexical:facet:bible-summary-detail") {
              return [];
            }
            if (key === "lexical:metadata") {
              return [
                {
                  doc_id: "bible-summary:Acts",
                  chunk_id: "bible-summary:Acts:0",
                  title: "أعمال الرسل",
                  url: "https://madraset-elshamamsa.com/articles/Ketab/Acts.php",
                  semanticDomain: "bible",
                  content_type: "bible_summary",
                  search_text: "الرسول بشر فرنسا في اعمال الرسل بولس كرازه",
                },
              ];
            }
            if (key === "bible-summary:Genesis:0") {
              return {
                doc_id: "bible-summary:Genesis",
                chunk_id: "bible-summary:Genesis:0",
                title: "تكوين",
                url: "https://madraset-elshamamsa.com/articles/Ketab/Genesis.php",
                text: "سفر التكوين يشرح بداية خلقة العالم والسقوط.",
                semanticDomain: "bible",
                content_type: "bible_summary",
              };
            }
            if (key === "bible-summary:John:1") {
              return {
                doc_id: "bible-summary:John",
                chunk_id: "bible-summary:John:1",
                title: "يوحنا",
                url: "https://madraset-elshamamsa.com/articles/Ketab/John.php",
                text: "في البدء كان الكلمة، والكلمة كان عند الله، وكان الكلمة الله. هنا معناها أزلية الابن.",
                semanticDomain: "bible",
                content_type: "bible_summary",
              };
            }
            return null;
          },
        },
      },
      "يعني إيه في البدء كان الكلمة؟",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["bible-summary:John:1"]);
    expect(chunks[0]).not.toHaveProperty("search_text");
  });
  test("does not use full body text for lexical scoring when retrieval fields exist", async () => {
    const chunks = await retrieveChunks(
      createLexicalOnlyEnv([
        {
          doc_id: "doc:body-only",
          chunk_id: "doc:body-only:0",
          title: "unrelated body only",
          url: "https://example.test/body-only",
          text: "needle phrase rareterm ".repeat(400),
          search_text: "unrelated retrieval surface",
          section: "unrelated",
          language: "en",
        },
        {
          doc_id: "doc:metadata-match",
          chunk_id: "doc:metadata-match:0",
          title: "metadata match",
          url: "https://example.test/metadata-match",
          text: "Original answer text is hydrated after retrieval.",
          search_text: "metadata rareterm",
          keywords: ["rareterm"],
          section: "metadata",
          language: "en",
        },
      ]),
      "needle phrase rareterm",
    );

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["doc:metadata-match:0"]);
  });

  test("does not delete top Bible-domain vector candidates when lexical fallback is strong", async () => {
    const cases = [
      {
        query: "مين الأنبياء اللي كانوا قبل السبي؟",
        expectedId: "ma3lomat:OldTestamentPanorama:0",
      },
      {
        query: "آية في سفر إشعياء عن إن ربنا ينظر للشخص المتواضع",
        expectedId: "verse:verse-231:0",
      },
    ];

    for (const testCase of cases) {
      const lexicalId = testCase.expectedId.startsWith("verse:")
        ? "bible-summary:Isaiah-3:0"
        : "bible-summary:Lamentations:1";
      const chunks = await retrieveChunks(
        {
          RETRIEVAL_TOP_K: "2",
          RETRIEVAL_CANDIDATE_K: "10",
          ASSISTANT_LEXICAL_KEYS: "lexical:domain",
          ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
          ASSISTANT_AI: {
            run: async () => ({ data: [[0.1, 0.2, 0.3]] }),
          },
          ASSISTANT_VECTORIZE: {
            query: async () => ({
              matches: [{ id: testCase.expectedId, score: 0.55 }],
            }),
          },
          ASSISTANT_CHUNKS: {
            get: async (key) => {
              if (key === "lexical:domain:bible") {
                return [
                  {
                    doc_id: lexicalId.replace(/:0$/, ""),
                    chunk_id: lexicalId,
                    title: testCase.query,
                    section: testCase.query,
                    url: "https://example.test/lexical-bible",
                    search_text: testCase.query,
                    semanticDomain: "bible",
                    content_type: "bible_summary",
                  },
                ];
              }
              if (
                key === "lexical:domain:ta3lim" ||
                key === "lexical:domain:taqs" ||
                key === "lexical:facet:bible-summary-detail" ||
                key === "lexical:facet:verse" ||
                key === "lexical:metadata"
              ) {
                return [];
              }
              if (key === testCase.expectedId) {
                return {
                  doc_id: testCase.expectedId.replace(/:0$/, ""),
                  chunk_id: testCase.expectedId,
                  title: "Expected vector source",
                  url: "https://example.test/vector-source",
                  text: "The source-backed answer.",
                  semanticDomain: "bible",
                  content_type: testCase.expectedId.startsWith("verse:")
                    ? "verse"
                    : "article",
                };
              }
              if (key === lexicalId) {
                return {
                  doc_id: lexicalId.replace(/:0$/, ""),
                  chunk_id: lexicalId,
                  title: testCase.query,
                  url: "https://example.test/lexical-bible",
                  text: "A broad lexical Bible result.",
                  semanticDomain: "bible",
                  content_type: "bible_summary",
                };
              }
              return null;
            },
          },
        },
        testCase.query,
      );

      expect(chunks.map((chunk) => chunk.chunk_id)).toContain(testCase.expectedId);
    }
  });

  test("keeps Bible-domain Vectorize search available for ambiguous service chronology", async () => {
    const vectorFilters: unknown[] = [];
    const chunks = await retrieveChunks(
      {
        RETRIEVAL_TOP_K: "1",
        RETRIEVAL_CANDIDATE_K: "10",
        ASSISTANT_LEXICAL_KEYS: "lexical:domain",
        ASSISTANT_EMBEDDING_MODEL: "@cf/test/embed",
        ASSISTANT_AI: {
          run: async () => ({ data: [[0.1, 0.2, 0.3]] }),
        },
        ASSISTANT_VECTORIZE: {
          query: async (_vector, options) => {
            vectorFilters.push(options?.filter);
            const domains = (options?.filter as { semanticDomain?: { $in?: string[] } })
              ?.semanticDomain?.$in ?? [];
            return {
              matches: [
                {
                  id: domains.includes("bible")
                    ? "ma3lomat:JesusLifeTimeline:0"
                    : "wa3zat:ThamarEl5edma:0",
                  score: 0.9,
                },
              ],
            };
          },
        },
        ASSISTANT_CHUNKS: {
          get: async (key) => {
            if (key.startsWith("lexical:")) return [];
            if (key === "ma3lomat:JesusLifeTimeline:0") {
              return {
                doc_id: "ma3lomat:JesusLifeTimeline",
                chunk_id: key,
                title: "بانوراما حياة السيد المسيح من الناحية التاريخية",
                url: "https://example.test/jesus-life",
                text: "السنة الأولى في الخدمة: المعمودية واختيار التلاميذ وعرس قانا.",
                semanticDomain: "bible",
                content_type: "article",
              };
            }
            if (key === "wa3zat:ThamarEl5edma:0") {
              return {
                doc_id: "wa3zat:ThamarEl5edma",
                chunk_id: key,
                title: "ثمار الخدمة",
                url: "https://example.test/service",
                text: "تعليم عام عن الخدمة.",
                semanticDomain: "ta3lim",
                content_type: "article",
              };
            }
            return null;
          },
        },
      },
      "إيه اللي حصل في أول سنة من خدمة السيد المسيح على الأرض؟",
    );

    expect(vectorFilters[0]).toMatchObject({
      semanticDomain: { $in: expect.arrayContaining(["bible", "ta3lim"]) },
    });
    expect(chunks[0]?.chunk_id).toBe("ma3lomat:JesusLifeTimeline:0");
  });
});

function createLexicalOnlyEnv(chunks: StoredChunk[]): Env {
  return {
    RETRIEVAL_TOP_K: "2",
    RETRIEVAL_CANDIDATE_K: "10",
    ASSISTANT_CHUNKS: {
      get: async (key) => {
        if (key === "lexical:wa3zat") {
          return chunks;
        }

        return chunks.find((chunk) => chunk.chunk_id === key) ?? null;
      },
    },
  };
}
