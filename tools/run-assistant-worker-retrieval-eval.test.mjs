#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
const scriptUrl = new URL("./run-assistant-worker-retrieval-eval.mjs", import.meta.url).href;
const bilingualDatasetUrl = new URL(
  "../examples/evals/assistant-bilingual-retrieval-eval.jsonl",
  import.meta.url,
);

test("uses the evaluation role without public quota identities", async () => {
  const { callAssistantWorker } = await import(scriptUrl);
  let request;
  await callAssistantWorker({
    endpoint: "https://worker.example/api/assistant/message",
    token: "eval-token",
    item: { id: "eval-1", query: "test" },
    fetchImpl: async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ retrieved_chunks: [] }), { status: 200 });
    },
  });

  const payload = JSON.parse(request.body);
  assert.equal(request.headers["x-assistant-eval-token"], "eval-token");
  assert.equal(payload.retrieval_only, true);
  assert.equal("assistant_device_id" in payload, false);
  assert.equal("session_id" in payload, false);
  assert.equal("user_id" in payload, false);
});

test("sends each eval item's declared UI locale", async () => {
  const { callAssistantWorker } = await import(scriptUrl);
  let request;
  await callAssistantWorker({
    endpoint: "https://worker.example/api/assistant/message",
    token: "eval-token",
    item: { id: "bilingual-001-en", query: "When is Omonogenis chanted?", locale: "en" },
    fetchImpl: async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ retrieved_chunks: [] }), { status: 200 });
    },
  });

  assert.equal(JSON.parse(request.body).locale, "en");
});

test("rejects an invalid explicit locale instead of coercing it to Arabic", async () => {
  const { callAssistantWorker } = await import(scriptUrl);

  await assert.rejects(
    callAssistantWorker({
      endpoint: "https://worker.example/api/assistant/message",
      token: "eval-token",
      item: { id: "bilingual-invalid", pair_id: "p2-bilingual-999", query: "test", locale: "fr" },
      fetchImpl: async () => new Response("{}", { status: 200 }),
    }),
    /locale must be ar or en/,
  );
});

test("bilingual dataset contains exactly 25 complete AR/EN source-parity pairs", async () => {
  const { loadJsonl, validateBilingualDataset } = await import(scriptUrl);
  const items = loadJsonl(bilingualDatasetUrl);
  validateBilingualDataset(items);
  const pairs = new Map();
  for (const item of items) {
    const rows = pairs.get(item.pair_id) ?? [];
    rows.push(item);
    pairs.set(item.pair_id, rows);
  }

  assert.equal(pairs.size, 25);
  assert.equal(items.length, 50);

  const coverage = new Set();
  for (const [pairId, rows] of pairs) {
    assert.match(pairId, /^p2-bilingual-\d{3}$/);
    assert.deepEqual(rows.map((row) => row.locale).sort(), ["ar", "en"]);
    assert.equal(new Set(rows.map((row) => row.expected_source_ref)).size, 1);
    assert.equal(new Set(rows.map((row) => row.expected_title)).size, 1);
    assert.equal(rows.every((row) => row.tier === "core"), true);
    rows.forEach((row) => coverage.add(row.coverage));
  }

  assert.deepEqual(
    [...coverage].sort(),
    ["coptic", "hymn_title", "liturgical_refusal", "proper_name", "weak_retrieval"],
  );
});

test("runtime validation rejects a bilingual subset and missing locale", async () => {
  const { loadJsonl, validateBilingualDataset } = await import(scriptUrl);
  const items = loadJsonl(bilingualDatasetUrl);

  assert.throws(() => validateBilingualDataset(items.slice(0, 48)), /exactly 50 rows and 25 pairs/);
  assert.throws(
    () => validateBilingualDataset(items.map((item, index) => index === 0 ? { ...item, locale: undefined } : item)),
    /locale must be ar or en/,
  );
});

test("recognizes the P2 dataset even when every pair_id is stripped", async () => {
  const { loadJsonl, requiresBilingualValidation } = await import(scriptUrl);
  const items = loadJsonl(bilingualDatasetUrl).map(({ pair_id: _pairId, ...item }) => item);

  assert.equal(requiresBilingualValidation(bilingualDatasetUrl, items), true);
});

test("runtime validation rejects duplicate IDs and mismatched pair metadata", async () => {
  const { loadJsonl, validateBilingualDataset } = await import(scriptUrl);
  const items = loadJsonl(bilingualDatasetUrl);

  assert.throws(
    () => validateBilingualDataset(items.map((item, index) => index === 1 ? { ...item, id: items[0].id } : item)),
    /duplicate item id/,
  );
  assert.throws(
    () => validateBilingualDataset(items.map((item, index) => index === 1 ? { ...item, expected_title: "مصدر مختلف" } : item)),
    /shared expected title and source/,
  );
  assert.throws(
    () => validateBilingualDataset(items.map((item, index) => index === 1 ? { ...item, coverage: "proper_name" } : item)),
    /shared coverage/,
  );
});

test("scores bilingual pairs only when both languages retrieve the shared source in top five", async () => {
  const { evaluateBilingualPairs } = await import(scriptUrl);
  const sharedItem = {
    pair_id: "p2-bilingual-001",
    expected_source_ref: "Omonogenis.mdx",
  };
  const pairs = evaluateBilingualPairs([
    { item: { ...sharedItem, id: "p2-bilingual-001-ar", locale: "ar" }, pass: true, rank: 2 },
    { item: { ...sharedItem, id: "p2-bilingual-001-en", locale: "en" }, pass: true, rank: 5 },
    {
      item: {
        pair_id: "p2-bilingual-002",
        id: "p2-bilingual-002-ar",
        locale: "ar",
        expected_source_ref: "TenO2osht.mdx",
      },
      pass: true,
      rank: 1,
    },
    {
      item: {
        pair_id: "p2-bilingual-002",
        id: "p2-bilingual-002-en",
        locale: "en",
        expected_source_ref: "TenO2osht.mdx",
      },
      pass: false,
      rank: null,
    },
  ]);

  assert.deepEqual(
    pairs.map((pair) => ({ pair_id: pair.pair_id, pass: pair.pass })),
    [
      { pair_id: "p2-bilingual-001", pass: true },
      { pair_id: "p2-bilingual-002", pass: false },
    ],
  );
});

test("fails the overall gate when any bilingual pair misses parity", async () => {
  const { evaluationPasses } = await import(scriptUrl);
  const results = [
    {
      item: { pair_id: "p2-bilingual-001", locale: "ar", expected_source_ref: "A.mdx" },
      pass: true,
      rank: 1,
      invariant_failures: [],
    },
    {
      item: { pair_id: "p2-bilingual-001", locale: "en", expected_source_ref: "A.mdx" },
      pass: false,
      rank: null,
      invariant_failures: [],
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      item: { id: `ordinary-${index}` },
      pass: true,
      rank: 1,
      invariant_failures: [],
    })),
  ];

  assert.equal(evaluationPasses(results.length, results), false);
});
test("matches expected source from returned chunks and checks response invariants", async () => {
  const { evaluateResponseForItem } = await import(scriptUrl);

  const item = {
    id: "wa3zat-core-001",
    query: "يعني إيه الطريق الداخلي؟",
    expected_title: "الطريق الداخلي",
    expected_source_ref: "ElTariqElDa5ely.md",
  };
  const response = {
    retrieved_chunks: [
      {
        doc_id: "wa3zat:Other",
        chunk_id: "wa3zat:Other:0",
        title: "مصدر آخر",
        url: "https://madraset-elshamamsa.com/articles/wa3zat/Other.php",
        text: "نص أصلي",
      },
      {
        doc_id: "wa3zat:ElTariqElDa5ely",
        chunk_id: "wa3zat:ElTariqElDa5ely:0",
        title: "الطريق الداخلي",
        url: "https://madraset-elshamamsa.com/articles/wa3zat/ElTariqElDa5ely.php",
        text: "حلّ مشاكل الحياة من الداخل.",
      },
    ],
  };

  const result = evaluateResponseForItem({ item, response, top: 5 });

  assert.equal(result.pass, true);
  assert.equal(result.rank, 2);
  assert.equal(result.invariant_failures.length, 0);
});

test("flags missing text and search_text leakage", async () => {
  const { evaluateResponseForItem } = await import(scriptUrl);

  const item = {
    id: "wa3zat-core-002",
    query: "ما معنى النفس؟",
    expected_title: "الطريق الداخلي",
    expected_source_ref: "ElTariqElDa5ely.md",
  };
  const response = {
    retrieved_chunks: [
      {
        doc_id: "wa3zat:ElTariqElDa5ely",
        chunk_id: "wa3zat:ElTariqElDa5ely:2",
        title: "الطريق الداخلي",
        url: "https://madraset-elshamamsa.com/articles/wa3zat/ElTariqElDa5ely.php",
        search_text: "normalized text must not leak",
      },
    ],
  };

  const result = evaluateResponseForItem({ item, response, top: 5 });

  assert.equal(result.pass, true);
  assert.deepEqual(result.invariant_failures, [
    "rank 1 missing original text",
    "rank 1 leaked search_text",
  ]);
});

test("accepts multiple expected sources for cross-book questions", async () => {
  const { evaluateResponseForItem } = await import(scriptUrl);

  const item = {
    id: "bible-deep-003",
    query: "مين هو ملشيصادق؟ و أين ذُكِر في الكتاب المقدس؟",
    expected_title: "تكوين أو العبرانيين",
    expected_source_refs: ["Genesis.mdx", "Hebrews.mdx"],
  };
  const response = {
    retrieved_chunks: [
      {
        doc_id: "bible-summary:Hebrews",
        chunk_id: "bible-summary:Hebrews:0",
        title: "العبرانيين",
        url: "https://madraset-elshamamsa.com/articles/Ketab/Hebrews.php",
        text: "نص أصلي",
      },
    ],
  };

  const result = evaluateResponseForItem({ item, response, top: 5 });

  assert.equal(result.pass, true);
  assert.equal(result.rank, 1);
});

test("renders a markdown report with pass rate and invariant failures", async () => {
  const { renderReport } = await import(scriptUrl);

  const report = renderReport({
    args: {
      endpoint: "http://localhost:8787/api/assistant/message",
      tier: "core",
      top: 5,
    },
    items: [{ id: "wa3zat-core-001" }, { id: "wa3zat-core-002" }],
    results: [
      {
        item: { id: "wa3zat-core-001", expected_title: "الطريق الداخلي" },
        pass: true,
        rank: 1,
        chunks: [
          {
            title: "الطريق الداخلي",
            section: "المحتوى",
            chunk_id: "wa3zat:ElTariqElDa5ely:0",
            url: "https://madraset-elshamamsa.com/articles/wa3zat/ElTariqElDa5ely.php",
          },
        ],
        invariant_failures: [],
      },
      {
        item: { id: "wa3zat-core-002", expected_title: "الطريق الداخلي" },
        pass: false,
        rank: null,
        chunks: [],
        invariant_failures: ["empty retrieval"],
      },
    ],
  });

  assert.equal(report.includes("# Wa3zat Assistant Worker Retrieval Eval Results"), true);
  assert.equal(report.includes("Expected source in top 5: 1/2 (50%)"), true);
  assert.equal(report.includes("Invariant failures: 1"), true);
  assert.equal(report.includes("wa3zat-core-002"), true);
});

test("labels bilingual reports with the strict P2 pair threshold", async () => {
  const { renderReport } = await import(scriptUrl);
  const item = {
    id: "p2-bilingual-001-ar",
    pair_id: "p2-bilingual-001",
    locale: "ar",
    expected_title: "لحن البركة",
    expected_source_ref: "TenO2osht.mdx",
  };
  const englishItem = { ...item, id: "p2-bilingual-001-en", locale: "en" };
  const result = (row) => ({
    item: row,
    pass: true,
    rank: 1,
    chunks: [],
    invariant_failures: [],
  });
  const report = renderReport({
    args: { endpoint: "http://localhost", tier: "core", top: 5 },
    items: [item, englishItem],
    results: [result(item), result(englishItem)],
  });

  assert.equal(report.includes("# Ask Zico P2 Bilingual Retrieval Eval Results"), true);
  assert.equal(report.includes("P2 threshold: 25/25 bilingual pairs with both languages in top 5"), true);
  assert.equal(report.includes("P0.3 threshold"), false);
});
