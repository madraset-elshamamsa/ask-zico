#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = {
    corpus: path.join(repoRoot, "analysis", "assistant-ingest", "wa3zat.jsonl"),
    eval: path.join(repoRoot, "scripts", "evals", "wa3zat-retrieval-eval.jsonl"),
    out: path.join(
      repoRoot,
      "analysis",
      "assistant-ingest",
      "wa3zat-retrieval-eval-results.md",
    ),
    tier: "core",
    top: 5,
    routeDomains: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    if (key === "top") {
      args.top = Number(next);
      if (!Number.isFinite(args.top) || args.top <= 0) {
        throw new Error("--top must be a positive number");
      }
    } else if (key === "routeDomains") {
      args.routeDomains = parseBoolean(next, "--routeDomains");
    } else {
      args[key] = next;
    }
    i += 1;
  }

  return args;
}

function parseBoolean(value, name) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

const ALL_DOMAINS = [
  "al7an",
  "taqs",
  "tari5",
  "saints",
  "coptic",
  "bible",
  "ta3lim",
  "school",
];

const DOMAIN_TERMS = {
  al7an: [
    "hymn",
    "tune",
    "melody",
    "\u0644\u062d\u0646",
    "\u0627\u0644\u062d\u0627\u0646",
    "\u0645\u0631\u062f",
    "\u0630\u0643\u0635\u0648\u0644\u0648\u062c\u064a\u0647",
    "\u062a\u0633\u0628\u062d\u0647",
  ],
  taqs: [
    "\u0637\u0642\u0633",
    "\u0642\u062f\u0627\u0633",
    "\u0627\u0641\u062e\u0627\u0631\u0633\u062a\u064a\u0627",
    "\u0628\u062e\u0648\u0631",
    "\u0635\u0648\u0645",
    "\u0639\u064a\u062f",
    "\u0627\u0639\u064a\u0627\u062f",
    "\u0627\u0633\u0631\u0627\u0631",
    "\u0643\u0646\u0633\u064a\u0627\u062a",
    "اختيار الحمل",
    "طبق الحمل",
    "قربان",
    "قربانه",
    "قربانات",
  ],
  tari5: [
    "\u062a\u0627\u0631\u064a\u062e",
    "\u0639\u0642\u064a\u062f\u0647",
    "\u0627\u0641\u062e\u0627\u0631\u0633\u062a\u064a\u0627",
    "\u0627\u0644\u0627\u0641\u062e\u0627\u0631\u0633\u062a\u064a\u0627",
    "\u0645\u062c\u0645\u0639",
    "\u0645\u062c\u0627\u0645\u0639",
    "\u0627\u064a\u0645\u0627\u0646",
    "\u0643\u0646\u064a\u0633\u0647",
    "\u0644\u0627\u0647\u0648\u062a",
  ],
  saints: [
    "\u0633\u0646\u0643\u0633\u0627\u0631",
    "\u0642\u062f\u064a\u0633",
    "\u0642\u062f\u064a\u0633\u0647",
    "\u0634\u0647\u064a\u062f",
    "\u0633\u064a\u0631\u0647",
  ],
  coptic: [
    "coptic",
    "\u0642\u0628\u0637\u064a",
    "\u0642\u0648\u0627\u0639\u062f",
    "\u0644\u063a\u0647 \u0642\u0628\u0637\u064a",
    "\u062d\u0631\u0648\u0641",
  ],
  bible: [
    "bible",
    "genesis",
    "exodus",
    "isaiah",
    "revelation",
    "verse",
    "verses",
    "\u0643\u062a\u0627\u0628",
    "\u0627\u064a\u0627\u062a",
    "\u0633\u0641\u0631",
    "\u0627\u0635\u062d\u0627\u062d",
    "\u062a\u0643\u0648\u064a\u0646",
    "\u062e\u0631\u0648\u062c",
    "\u0644\u0627\u0648\u064a\u064a\u0646",
    "\u0639\u062f\u062f",
    "\u062a\u062b\u0646\u064a\u0647",
    "\u064a\u0634\u0648\u0639",
    "\u0642\u0636\u0627\u0647",
    "\u0631\u0627\u0639\u0648\u062b",
    "\u0635\u0645\u0648\u0626\u064a\u0644",
    "\u0645\u0644\u0648\u0643",
    "\u0627\u062e\u0628\u0627\u0631 \u0627\u0644\u0627\u064a\u0627\u0645",
    "\u0639\u0632\u0631\u0627",
    "\u0646\u062d\u0645\u064a\u0627",
    "\u0627\u0633\u062a\u064a\u0631",
    "\u0627\u064a\u0648\u0628",
    "\u0645\u0632\u0627\u0645\u064a\u0631",
    "\u0645\u0632\u0645\u0648\u0631",
    "\u0627\u0645\u062b\u0627\u0644",
    "\u062c\u0627\u0645\u0639\u0647",
    "\u0646\u0634\u064a\u062f \u0627\u0644\u0627\u0646\u0634\u0627\u062f",
    "\u0627\u0634\u0639\u064a\u0627\u0621",
    "\u0627\u0631\u0645\u064a\u0627",
    "\u0645\u0631\u0627\u062b\u064a \u0627\u0631\u0645\u064a\u0627",
    "\u062d\u0632\u0642\u064a\u0627\u0644",
    "\u062f\u0627\u0646\u064a\u0627\u0644",
    "\u0647\u0648\u0634\u0639",
    "\u064a\u0648\u0626\u064a\u0644",
    "\u0639\u0627\u0645\u0648\u0633",
    "\u0639\u0648\u0628\u062f\u064a\u0627",
    "\u064a\u0648\u0646\u0627\u0646",
    "\u0645\u064a\u062e\u0627",
    "\u0646\u0627\u062d\u0648\u0645",
    "\u062d\u0628\u0642\u0648\u0642",
    "\u0635\u0641\u0646\u064a\u0627",
    "\u062d\u062c\u064a",
    "\u0632\u0643\u0631\u064a\u0627",
    "\u0645\u0644\u0627\u062e\u064a",
    "\u0645\u062a\u0649",
    "\u0645\u0631\u0642\u0633",
    "\u0644\u0648\u0642\u0627",
    "\u064a\u0648\u062d\u0646\u0627",
    "\u0627\u0639\u0645\u0627\u0644 \u0627\u0644\u0631\u0633\u0644",
    "\u0631\u0648\u0645\u064a\u0647",
    "\u0643\u0648\u0631\u0646\u062b\u0648\u0633",
    "\u063a\u0644\u0627\u0637\u064a\u0647",
    "\u0627\u0641\u0633\u0633",
    "\u0641\u064a\u0644\u0628\u064a",
    "\u0643\u0648\u0644\u0648\u0633\u064a",
    "\u062a\u0633\u0627\u0644\u0648\u0646\u064a\u0643\u064a",
    "\u062a\u064a\u0645\u0648\u062b\u0627\u0648\u0633",
    "\u062a\u064a\u0637\u0633",
    "\u0641\u0644\u064a\u0645\u0648\u0646",
    "\u0639\u0628\u0631\u0627\u0646\u064a\u064a\u0646",
    "\u064a\u0639\u0642\u0648\u0628",
    "\u0628\u0637\u0631\u0633",
    "\u064a\u0647\u0648\u0630\u0627",
    "\u0631\u0624\u064a\u0627",
    "\u0645\u0632\u0645\u0648\u0631",
    "\u0627\u0646\u062c\u064a\u0644",
    "\u0628\u0648\u0644\u0633",
    "\u0631\u0633\u0627\u0644\u0647",
  ],
  ta3lim: [
    "\u0648\u0639\u0638\u0647",
    "\u062a\u0639\u0644\u064a\u0645",
    "\u062a\u0627\u0645\u0644",
    "\u0646\u062a\u0639\u0644\u0645",
    "\u062f\u0631\u0648\u0633",
    "\u062a\u0648\u0628\u0647",
    "\u062e\u062f\u0645\u0647",
    "\u0645\u062d\u0628\u0647",
    "\u0641\u0636\u064a\u0644\u0647",
    "\u0627\u0628\u0627\u0621",
  ],
  school: [
    "school",
    "\u0645\u062f\u0631\u0633\u0647",
    "\u0645\u062f\u0627\u0631\u0633",
    "\u0645\u0646\u0647\u062c",
    "\u062f\u0631\u0633",
  ],
};

const METADATA_STRONG_SCORE_THRESHOLD = 65;
const METADATA_WEAK_SCORE_THRESHOLD = 8;
const ROUTED_WEAK_SCORE_THRESHOLD = 20;

const BROAD_FEAST_TERMS = [
  "\u0639\u064a\u062f",
  "\u0627\u0639\u064a\u0627\u062f",
  "\u0627\u0644\u0645\u064a\u0644\u0627\u062f",
  "\u0627\u0644\u063a\u0637\u0627\u0633",
  "\u0627\u0644\u0642\u064a\u0627\u0645\u0647",
  "\u0627\u0644\u062a\u062c\u0633\u062f",
];
const AMBIGUOUS_TA3LIM_TERMS = new Set(
  ["خدمه", "محبه", "فضيله", "اباء"].map(normalizeArabicForSearch),
);

const QUERY_STOPWORDS = new Set(
  [
    "ايه",
    "ما",
    "ماذا",
    "مين",
    "من",
    "هو",
    "هي",
    "اللي",
    "الذي",
    "التي",
    "عن",
    "في",
    "على",
    "الى",
    "اين",
    "ازاي",
    "كيف",
    "هل",
    "كان",
    "كانت",
    "ذكر",
    "ذكرت",
    "المذكور",
    "المذكوره",
    "الكتاب",
    "المقدس",
  ].flatMap((term) => {
    const normalized = normalizeArabicForSearch(term);
    return [normalized, stripArabicArticle(normalized)];
  }),
);
const LOW_SIGNAL_TERMS = new Set(
  ["المسيح", "يسوع", "السيد", "ربنا", "الرب", "الله"].map((term) =>
    normalizeArabicForSearch(term),
  ),
);

function normalizeArabicForSearch(input) {
  return input
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ـ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function routeRetrievalDomains(query) {
  const normalized = normalizeArabicForSearch(query);
  const scores = Object.fromEntries(ALL_DOMAINS.map((domain) => [domain, 0]));
  let hasAmbiguousTa3limSignal = false;

  for (const domain of ALL_DOMAINS) {
    for (const term of DOMAIN_TERMS[domain]) {
      const normalizedTerm = normalizeArabicForSearch(term);
      if (!normalized.includes(normalizedTerm)) {
        continue;
      }
      if (domain === "ta3lim" && AMBIGUOUS_TA3LIM_TERMS.has(normalizedTerm)) {
        hasAmbiguousTa3limSignal = true;
        continue;
      }
      scores[domain] += term.length > 4 ? 3 : 2;
    }
  }
  if (hasAmbiguousTa3limSignal) {
    scores.ta3lim = Math.max(scores.ta3lim, 1);
  }

  const hasBroadFeastTerm = BROAD_FEAST_TERMS.some((term) =>
    normalized.includes(normalizeArabicForSearch(term)),
  );
  if (hasBroadFeastTerm) {
    scores.taqs += 3;
    scores.bible += 3;
    scores.ta3lim += 3;
  }

  const maxScore = Math.max(...Object.values(scores));
  if (maxScore < 2) {
    return ["ta3lim", "bible", "taqs"];
  }

  const domains = new Set(
    ALL_DOMAINS.filter((domain) =>
      hasBroadFeastTerm
        ? scores[domain] >= 3
        : scores[domain] >= Math.max(2, maxScore - 1),
    ),
  );

  if (scores.bible > 0 && scores.ta3lim > 0) {
    domains.add("bible");
    domains.add("ta3lim");
  }

  if (scores.bible > 0 && scores.ta3lim === 0 && scores.bible <= 3) {
    domains.add("ta3lim");
  }

  return [...domains];
}

function loadJsonl(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function tokenize(input) {
  const tokens = normalizeArabicForSearch(input)
    .split(/\s+/)
    .filter((token) => token.length > 1);
  return [...new Set(tokens.flatMap(tokenVariants))].filter(
    (token) => token.length > 1 && !QUERY_STOPWORDS.has(token),
  );
}

function tokenVariants(token) {
  return [token, stripArabicArticle(token)];
}

function stripArabicArticle(token) {
  if (token.startsWith("\u0627\u0644") && token.length > 3) {
    return token.slice(2);
  }
  return token;
}

function lexicalTokenFactor(token) {
  return LOW_SIGNAL_TERMS.has(token) ? 0.25 : 1;
}

function joinArray(value) {
  return Array.isArray(value) ? value.join(" ") : "";
}

function hasBibleRetrievalIntent(normalizedQuery) {
  return [
    "كتاب",
    "الكتاب المقدس",
    "سفر",
    "اصحاح",
    "ايه",
    "ايات",
    "تكوين",
    "خروج",
    "مزمور",
    "انجيل",
    "رساله",
    "العهد القديم",
    "العهد الجديد",
  ].some((term) => normalizedQuery.includes(normalizeArabicForSearch(term)));
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function containsTokenVariant(haystack, token) {
  if (haystack.includes(token)) return true;
  if (token.length < 4) return false;
  return stripInternalAlefs(haystack).includes(stripInternalAlefs(token));
}

function stripInternalAlefs(value) {
  return value
    .split(/\s+/)
    .map((token) => {
      if (token.length < 4) return token;
      return `${token[0]}${token.slice(1).replace(/ا/g, "")}`;
    })
    .join(" ");
}

function scoreChunk(chunk, queryTokens, normalizedQuery) {
  let score = 0;
  const queryPhrases = buildQueryPhrases(queryTokens);
  const title = normalizeArabicForSearch(chunk.title || "");
  const section = normalizeArabicForSearch(chunk.section || "");
  const summary = normalizeArabicForSearch(chunk.summary || "");
  const categories = normalizeArabicForSearch(joinArray(chunk.categories));
  const keywords = normalizeArabicForSearch(joinArray(chunk.keywords));
  const facets = normalizeArabicForSearch(joinArray(chunk.facets));
  const authors = normalizeArabicForSearch(joinArray(chunk.authors));
  const semanticDomain = normalizeArabicForSearch(chunk.semanticDomain || "");
  const shouldUseEnrichment = chunk.semanticDomain === "bible" || chunk.semanticDomain === "taqs";
  const eventTerms = shouldUseEnrichment ? normalizeArabicForSearch(joinArray(chunk.events)) : "";
  const aliasTerms = shouldUseEnrichment ? normalizeArabicForSearch(joinArray(chunk.aliases)) : "";
  const entityTerms = shouldUseEnrichment ? normalizeArabicForSearch(joinArray(chunk.entities)) : "";
  const placeTerms = shouldUseEnrichment ? normalizeArabicForSearch(joinArray(chunk.places)) : "";
  const symbolTerms = shouldUseEnrichment ? normalizeArabicForSearch(joinArray(chunk.symbols)) : "";
  const themeTerms = shouldUseEnrichment ? normalizeArabicForSearch(joinArray(chunk.themes)) : "";
  const enrichedTerms = shouldUseEnrichment
    ? normalizeArabicForSearch(joinArray(chunk.enriched_terms))
    : "";
  const text = chunk.search_text || "";

  if (text.includes(normalizedQuery)) score += 12;
  if (title.includes(normalizedQuery)) score += 20;
  if (section.includes(normalizedQuery)) score += 10;

  const phraseHaystacks = [
    { value: title, weight: 20 },
    { value: section, weight: 10 },
    { value: text, weight: 12 },
    { value: summary, weight: 8 },
    { value: categories, weight: 8 },
    { value: keywords, weight: 8 },
    { value: semanticDomain, weight: 8 },
    { value: facets, weight: 8 },
    { value: authors, weight: 6 },
    { value: eventTerms, weight: 36, structured: true },
    { value: aliasTerms, weight: 36, structured: true },
    { value: entityTerms, weight: 24, structured: true },
    { value: placeTerms, weight: 24, structured: true },
    { value: symbolTerms, weight: 20, structured: true },
    { value: themeTerms, weight: 16, structured: true },
    { value: enrichedTerms, weight: 12, structured: true },
  ];

  for (const haystack of phraseHaystacks) {
    const compactValue = compactSearchValue(haystack.value);
    for (const phrase of queryPhrases) {
      if (haystack.value.includes(phrase)) {
        score += haystack.structured
          ? haystack.weight
          : Math.max(2, Math.floor(haystack.weight / 2));
      }
      if (compactValue.includes(compactSearchValue(phrase))) {
        score += haystack.structured
          ? Math.max(2, Math.floor(haystack.weight / 2))
          : Math.max(2, Math.floor(haystack.weight / 3));
      }
    }
  }

  for (const token of queryTokens) {
    const tokenFactor = lexicalTokenFactor(token);
    if (containsTokenVariant(title, token)) score += 8 * tokenFactor;
    if (containsTokenVariant(section, token)) score += 4 * tokenFactor;
    if (containsTokenVariant(summary, token)) score += 3 * tokenFactor;
    if (containsTokenVariant(categories, token)) score += 3 * tokenFactor;
    if (containsTokenVariant(keywords, token)) score += 3 * tokenFactor;
    if (containsTokenVariant(semanticDomain, token)) score += 3 * tokenFactor;
    if (containsTokenVariant(facets, token)) score += 3 * tokenFactor;
    if (containsTokenVariant(authors, token)) score += 2 * tokenFactor;
    if (containsTokenVariant(eventTerms, token)) score += 18 * tokenFactor;
    if (containsTokenVariant(aliasTerms, token)) score += 18 * tokenFactor;
    if (containsTokenVariant(entityTerms, token)) score += 12 * tokenFactor;
    if (containsTokenVariant(placeTerms, token)) score += 12 * tokenFactor;
    if (containsTokenVariant(symbolTerms, token)) score += 10 * tokenFactor;
    if (containsTokenVariant(themeTerms, token)) score += 8 * tokenFactor;
    if (containsTokenVariant(enrichedTerms, token)) score += 6 * tokenFactor;
    score += Math.min(countOccurrences(text, token), 8) * tokenFactor;
  }

  score += titleCoveragePrior(title, queryTokens);

  return score;
}

function buildQueryPhrases(tokens) {
  const phrases = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    for (let size = 2; size <= 4; size += 1) {
      const parts = tokens.slice(index, index + size);
      if (parts.length === size) {
        phrases.add(parts.join(" "));
      }
    }
  }
  return [...phrases];
}

function compactSearchValue(value) {
  return value.replace(/\s+/g, "");
}

function titleCoveragePrior(normalizedTitle, queryTokens) {
  const titleTokens = tokenize(normalizedTitle);
  if (!titleTokens.length) return 0;

  const queryTokenSet = new Set(queryTokens);
  const matched = titleTokens.filter((token) => queryTokenSet.has(token)).length;
  const coverage = matched / titleTokens.length;

  if (coverage >= 1) return 40;
  if (coverage >= 0.5) return 18 * coverage;
  return 0;
}

function scoreMetadataChunk(chunk, queryTokens, normalizedQuery) {
  const title = normalizeArabicForSearch(chunk.title || "");
  const section = normalizeArabicForSearch(chunk.section || "");
  const exactNameBoost = title === normalizedQuery || section === normalizedQuery ? 80 : 0;
  return exactNameBoost + scoreChunk(
    {
      ...chunk,
      search_text: "",
      text: "",
      detail_search_text: "",
      events: [],
      aliases: [],
      entities: [],
      places: [],
      symbols: [],
      themes: [],
      enriched_terms: [],
    },
    queryTokens,
    normalizedQuery,
  );
}

function mergeHits(primaryHits, metadataHits, top) {
  const bySource = new Map();
  for (const hit of [...primaryHits, ...metadataHits]) {
    const key = hit.chunk.chunk_id || hit.chunk.source_ref || hit.chunk.title;
    const current = bySource.get(key);
    if (!current || hit.score > current.score) {
      bySource.set(key, hit);
    }
  }
  return [...bySource.values()].sort((a, b) => b.score - a.score).slice(0, top);
}

function routedRows(rows, query, shouldRoute) {
  if (!shouldRoute) return { rows, domains: [] };
  const domains = routeRetrievalDomains(query);
  const filtered = rows.filter((row) => domains.includes(row.semanticDomain));
  return { rows: filtered.length ? filtered : rows, domains };
}

function search(rows, query, top, options = {}) {
  const routed = routedRows(rows, query, options.routeDomains);
  const normalizedQuery = normalizeArabicForSearch(query);
  const queryTokens = tokenize(query);
  const routedHits = routed.rows
    .map((chunk) => ({
      chunk,
      score: scoreChunk(chunk, queryTokens, normalizedQuery),
    }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!options.routeDomains) {
    return { hits: routedHits.slice(0, top), domains: routed.domains };
  }

  const strongestRoutedScore = routedHits[0]?.score ?? 0;
  const metadataThreshold =
    strongestRoutedScore < ROUTED_WEAK_SCORE_THRESHOLD
      ? METADATA_WEAK_SCORE_THRESHOLD
      : METADATA_STRONG_SCORE_THRESHOLD;
  const metadataHits = rows
    .map((chunk) => ({
      chunk,
      score: scoreMetadataChunk(chunk, queryTokens, normalizedQuery),
    }))
    .filter((hit) => hit.score >= metadataThreshold)
    .sort((a, b) => b.score - a.score);

  return { hits: mergeHits(routedHits, metadataHits, top), domains: routed.domains };
}

function sourceSlug(sourceRef) {
  return sourceRef.replace(/\.mdx?$/i, "");
}

function expectedSourceRefs(item) {
  if (Array.isArray(item.expected_source_refs) && item.expected_source_refs.length) {
    return item.expected_source_refs;
  }
  return [item.expected_source_ref];
}

function corpusLabel(corpusPath) {
  return path.basename(corpusPath).replace(/\.jsonl$/i, "");
}

function renderReport({ args, items, results }) {
  const passed = results.filter((result) => result.pass).length;
  const top1 = results.filter((result) => result.rank === 1).length;
  const thresholdPass = passed / items.length >= 0.8;
  const lines = [
    "# Assistant Retrieval Eval Results",
    "",
    `> Generated: ${new Date().toISOString()} | Corpus: ${corpusLabel(args.corpus)} | Retriever: local lexical sanity check`,
    "",
    "## Summary",
    "",
    `- Tier: ${args.tier}`,
    `- Questions: ${items.length}`,
    `- Domain routing: ${args.routeDomains ? "enabled" : "disabled"}`,
    `- Expected source in top ${args.top}: ${passed}/${items.length} (${Math.round(
      (passed / items.length) * 100,
    )}%)`,
    `- Expected source at rank 1: ${top1}/${items.length} (${Math.round(
      (top1 / items.length) * 100,
    )}%)`,
    "- P0.2 threshold: 80% top-5",
    `- Status: ${thresholdPass ? "PASS" : "FAIL"}`,
    "",
    "## Results",
    "",
    "| ID | Expected | Rank | Top Results | Notes |",
    "|---|---|---:|---|---|",
  ];

  for (const result of results) {
    const topResults = result.hits
      .map(
        (hit, index) =>
          `${index + 1}. ${hit.chunk.title} / ${hit.chunk.section} (${hit.score})`,
      )
      .join("<br>")
      .replace(/\|/g, "\\|");
    lines.push(
      `| ${result.item.id} | ${result.item.expected_title} | ${result.rank ?? "MISS"
      } | ${topResults} | ${result.pass
        ? `pass${result.domains.length ? `; domains=${result.domains.join(",")}` : ""}`
        : `expected source not in top results${result.domains.length ? `; domains=${result.domains.join(",")}` : ""
        }`
      } |`,
    );
  }

  const misses = results.filter((result) => !result.pass);
  lines.push("", "## Misses", "");
  if (!misses.length) {
    lines.push("None.");
  } else {
    for (const result of misses) {
      lines.push(
        `- ${result.item.id}: ${result.item.query} -> expected ${result.item.expected_title} (${result.item.expected_source_ref})`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = loadJsonl(args.corpus);
  const items = loadJsonl(args.eval).filter((item) => item.tier === args.tier);
  if (!items.length) {
    throw new Error(`No eval items found for tier: ${args.tier}`);
  }

  const results = items.map((item) => {
    const { hits, domains } = search(rows, item.query, args.top, {
      routeDomains: args.routeDomains,
    });
    const expected = expectedSourceRefs(item).map(sourceSlug);
    const rankIndex = hits.findIndex(
      (hit) => expected.includes(sourceSlug(hit.chunk.source_ref || "")),
    );
    return {
      item,
      hits,
      domains,
      pass: rankIndex !== -1,
      rank: rankIndex === -1 ? null : rankIndex + 1,
    };
  });

  const report = renderReport({ args, items, results });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, report, "utf8");

  const passed = results.filter((result) => result.pass).length;
  const top1 = results.filter((result) => result.rank === 1).length;
  console.log(`Tier: ${args.tier}`);
  console.log(`Questions: ${items.length}`);
  console.log(`Top-${args.top}: ${passed}/${items.length}`);
  console.log(`Rank-1: ${top1}/${items.length}`);
  console.log(`Status: ${passed / items.length >= 0.8 ? "PASS" : "FAIL"}`);
  console.log(`Report: ${args.out}`);
}

main();
