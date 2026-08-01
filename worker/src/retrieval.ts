import type {
  Env,
  RetrievalDebugReport,
  RetrievedChunk,
  StoredChunk,
  VectorizeMatch,
  AssistantCpuPhaseRecorder,
} from "./types";
import { routeRetrievalDomains } from "./domain-router";
import { normalizeArabicForSearch } from "./arabic";
import type { SemanticDomain } from "./domain-router";
import { relativeSeneksarDateKey } from "./seneksar-date";

type RetrievalCandidate = {
  chunk_id: string;
  rank: number;
  source: "vector" | "lexical" | "metadata";
  score: number;
  chunk?: StoredChunk;
  structuredMatch?: boolean;
  semanticDomain?: SemanticDomain;
  sourceLibrary?: string;
};

type LexicalRecord = Partial<StoredChunk> & {
  doc_id: string;
  chunk_id: string;
  title: string;
  url: string;
};

type DomainScores = Record<SemanticDomain, number>;

type LexicalQueryFeatures = {
  normalizedQuery: string;
  tokens: string[];
  phrases: string[];
  compactQuery: string;
  looseTokens: string[];
  coverageTokenGroups: string[][];
  rawTokenCount: number;
};

const DEFAULT_TOP_K = 5;
const DEFAULT_CANDIDATE_K = 30;
const RRF_K = 60;
const LEXICAL_SCORE_WEIGHT = 0.001;
const BROAD_TITLE_INTRO_PRIOR = 15;
const LEXICAL_LOW_VECTOR_SCORE_THRESHOLD = 0.65;
const LEXICAL_STRONG_SCORE_THRESHOLD = 30;
const METADATA_STRONG_SCORE_THRESHOLD = 65;
const METADATA_WEAK_SCORE_THRESHOLD = 8;
const METADATA_LEXICAL_KEY = "lexical:metadata";
const DEFAULT_LEXICAL_CORPUS_KEYS = ["lexical:wa3zat"];
const OPTIONAL_SOURCE_LIBRARIES = ["about", "aqwal", "cartoon", "coptic", "seneksar"] as const;
type OptionalSourceLibrary = typeof OPTIONAL_SOURCE_LIBRARIES[number];

const OPTIONAL_SOURCE_FLAGS: Record<OptionalSourceLibrary, keyof Env> = {
  about: "ASSISTANT_ABOUT_ENABLED",
  aqwal: "ASSISTANT_AQWAL_ENABLED",
  cartoon: "ASSISTANT_CARTOON_ENABLED",
  coptic: "ASSISTANT_COPTIC_ENABLED",
  seneksar: "ASSISTANT_SENEKSAR_ENABLED",
};


const EMPTY_DOMAIN_FALLBACKS: Partial<Record<SemanticDomain, SemanticDomain[]>> = {
  al7an: ["taqs", "bible", "ta3lim"],
  coptic: ["tari5", "ta3lim", "taqs"],
  school: ["ta3lim", "bible", "taqs"],
  saints: ["tari5", "ta3lim"],
};
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

function optionalSourceEnabled(source: OptionalSourceLibrary, env: Env): boolean {
  return env[OPTIONAL_SOURCE_FLAGS[source]] === "true";
}

function containsQueryTerm(normalizedQuery: string, terms: string[]): boolean {
  return terms.some((term) => normalizedQuery.includes(normalizeArabicForSearch(term)));
}

function optionalSourceEligible(
  source: OptionalSourceLibrary,
  env: Env,
  normalizedQuery: string,
  routedDomains: SemanticDomain[],
): boolean {
  if (!optionalSourceEnabled(source, env)) return false;
  if (source === "cartoon") {
    return containsQueryTerm(normalizedQuery, ["cartoon", "كارتون", "فيديو كارتون", "فيلم كارتون"]);
  }
  if (source === "aqwal") {
    return containsQueryTerm(normalizedQuery, ["quote", "quotes", "قول", "أقوال", "اقوال", "مقولة", "قال القديس", "قال الأب", "قال الاب"]);
  }
  if (source === "coptic") return routedDomains.includes("coptic");
  if (source === "about") return routedDomains.includes("school");
  return routedDomains.includes("saints") ||
    containsQueryTerm(normalizedQuery, ["سنكسار", "النهاردة", "بكرة", "مين هو", "من هو", "مين هي", "من هي"]);
}

function excludedOptionalSources(
  env: Env,
  normalizedQuery: string,
  routedDomains: SemanticDomain[],
): OptionalSourceLibrary[] {
  return OPTIONAL_SOURCE_LIBRARIES.filter(
    (source) => !optionalSourceEligible(source, env, normalizedQuery, routedDomains),
  );
}

function eligibleOptionalSources(
  env: Env,
  normalizedQuery: string,
  routedDomains: SemanticDomain[],
): OptionalSourceLibrary[] {
  return OPTIONAL_SOURCE_LIBRARIES.filter(
    (source) => optionalSourceEligible(source, env, normalizedQuery, routedDomains),
  );
}
function enabledDomains(
  domains: SemanticDomain[],
  env: Env,
  explicitAl7anIntent = false,
): SemanticDomain[] {
  if (env.ASSISTANT_AL7AN_ENABLED === "true" || explicitAl7anIntent) return domains;
  const filtered = domains.filter((domain) => domain !== "al7an");
  return filtered.length ? filtered : ["ta3lim", "bible", "taqs"];
}

function hasExplicitAl7anIntent(normalizedQuery: string): boolean {
  return ["لحن", "الحان", "hymn", "tune", "melody"].some((term) =>
    normalizedQuery.includes(normalizeArabicForSearch(term)),
  );
}

function filterQuietMetadataCandidates(
  candidates: RetrievalCandidate[],
  env: Env,
  explicitAl7anIntent: boolean,
): RetrievalCandidate[] {
  return candidates.filter((candidate) => {
    const optionalSource = OPTIONAL_SOURCE_LIBRARIES.find(
      (source) => source === candidate.sourceLibrary,
    );
    if (
      optionalSource &&
      !optionalSourceEnabled(optionalSource, env) &&
      candidate.score < METADATA_STRONG_SCORE_THRESHOLD
    ) {
      return false;
    }

    return env.ASSISTANT_AL7AN_ENABLED === "true" ||
      explicitAl7anIntent ||
      candidate.semanticDomain !== "al7an" ||
      candidate.score >= METADATA_STRONG_SCORE_THRESHOLD ||
      candidate.structuredMatch === true;
  });
}

export async function retrieveChunks(
  env: Env,
  normalizedQuery: string,
  cpu?: AssistantCpuPhaseRecorder,
): Promise<RetrievedChunk[]> {
  const topK = parsePositiveInt(env.RETRIEVAL_TOP_K, DEFAULT_TOP_K, 20);
  const candidateK = parsePositiveInt(
    env.RETRIEVAL_CANDIDATE_K,
    DEFAULT_CANDIDATE_K,
    100,
  );

  const searchQuery = normalizeArabicForSearch(normalizedQuery).toLowerCase();
  const queryFeatures = createLexicalQueryFeatures(searchQuery);
  const route = routeRetrievalDomains(searchQuery);
  const explicitAl7anIntent = hasExplicitAl7anIntent(searchQuery);
  let routedDomains = enabledDomains(route.domains, env, explicitAl7anIntent);
  let preloadedMetadataCandidates: RetrievalCandidate[] | undefined;
  if (shouldDiscoverDomainsFromMetadata(queryFeatures, route.scores)) {
    preloadedMetadataCandidates = await retrieveMetadataCandidates(
      env,
      queryFeatures,
      candidateK,
      cpu,
    );
    routedDomains = enabledDomains(
      discoveredMetadataDomains(routedDomains, preloadedMetadataCandidates),
      env,
      explicitAl7anIntent,
    );
  }
  const vectorCandidates = await retrieveVectorCandidates(
    env,
    searchQuery,
    candidateK,
    routedDomains,
    cpu,
  );
  const hydrationCache = new Map<string, unknown>();
  const vectorOnly = await hydrateCandidates(env, vectorCandidates, topK, cpu, "vector_hydration", hydrationCache);
  const shouldRunLexical = shouldRunLexicalFallback(
    env,
    queryFeatures,
    routedDomains,
    route.scores,
    vectorCandidates,
    vectorOnly,
  );

  if (!shouldRunLexical) {
    return vectorOnly.slice(0, topK);
  }

  const primaryLexicalDomains = lexicalFallbackDomains(routedDomains, vectorCandidates);
  let lexicalCandidates = await retrieveLexicalCandidates(
    env,
    queryFeatures,
    candidateK,
    primaryLexicalDomains,
    route.scores,
    cpu,
  );
  if (shouldExpandEmptyDomainFallback(routedDomains, vectorOnly, lexicalCandidates)) {
    lexicalCandidates = await retrieveLexicalCandidates(
      env,
      queryFeatures,
      candidateK,
      expandedEmptyDomainFallbackDomains(primaryLexicalDomains),
      route.scores,
      cpu,
    );
  }
  const retrievedMetadataCandidates =
    Boolean(preloadedMetadataCandidates?.length) ||
      !vectorCandidates.length ||
      shouldUseMetadataFallback(routedDomains, route.scores) ||
      (vectorCandidates[0]?.score ?? 1) < LEXICAL_LOW_VECTOR_SCORE_THRESHOLD
      ? preloadedMetadataCandidates ??
        await retrieveMetadataCandidates(env, queryFeatures, candidateK, cpu)
      : [];
  const eligibleMetadataCandidates = filterQuietMetadataCandidates(
    retrievedMetadataCandidates,
    env,
    explicitAl7anIntent,
  );
  const metadataCandidates = route.strictDomains && (vectorOnly.length || lexicalCandidates.length)
    ? []
    : route.strictDomains
      ? eligibleMetadataCandidates.filter((candidate) =>
        candidate.semanticDomain !== undefined && routedDomains.includes(candidate.semanticDomain)
      )
      : eligibleMetadataCandidates;
  const strongMetadataCandidates = metadataCandidates.filter(
    (candidate) => candidate.score >= METADATA_STRONG_SCORE_THRESHOLD,
  );

  const metadataForFusion = metadataCandidates.filter((candidate) =>
    candidate.score >=
    (strongMetadataCandidates.length ? METADATA_STRONG_SCORE_THRESHOLD : METADATA_WEAK_SCORE_THRESHOLD),
  );
  const hasTopNonBibleVectorCandidate = hasTopNonBibleVectorResult(vectorOnly);
  const fallbackCandidates = [
    ...lexicalCandidates.filter(
      (candidate) =>
        !(
          hasTopNonBibleVectorCandidate &&
          isBibleLexicalCandidate(candidate) &&
          !hasStrongStructuredLexicalMatch(candidate, queryFeatures)
        ),
    ),
    ...metadataForFusion,
  ];
  const candidatesForFusion = [...vectorCandidates, ...fallbackCandidates];
  const fused = fuseCandidates(
    candidatesForFusion,
    route.strictDomains ? { lexicalScoreWeight: 0, vectorRankWeight: 1.3 } : undefined,
  );
  const hydrated = await hydrateCandidates(env, fused, topK, cpu, "final_hydration", hydrationCache);

  return hydrated.slice(0, topK);
}

function shouldRunLexicalFallback(
  env: Env,
  queryFeatures: LexicalQueryFeatures,
  routedDomains: SemanticDomain[],
  domainScores: DomainScores,
  vectorCandidates: RetrievalCandidate[],
  vectorChunks: RetrievedChunk[],
): boolean {
  void env;
  if (!vectorCandidates.length || !vectorChunks.length) {
    return true;
  }

  if ((domainScores.ta3lim ?? 0) > 0) {
    return true;
  }

  if (
    routedDomains.includes("taqs") &&
    hasRitualBoundaryIntent(queryFeatures.normalizedQuery)
  ) {
    return true;
  }

  if (routedDomains.includes("tari5") || routedDomains.includes("saints")) {
    if (queryFeatures.rawTokenCount >= 4) {
      return true;
    }
    if (hasExactRetrievalIntent(queryFeatures, routedDomains, domainScores, vectorChunks)) {
      return true;
    }
    const routedSet = new Set<string>(routedDomains);
    if (vectorChunks.some((chunk) => chunk.semanticDomain && routedSet.has(chunk.semanticDomain))) {
      return false;
    }
    if (vectorChunks.some((chunk) => chunk.semanticDomain)) {
      return true;
    }
  }

  if (vectorCandidates[0]?.score < LEXICAL_LOW_VECTOR_SCORE_THRESHOLD) {
    return true;
  }

  return hasExactRetrievalIntent(
    queryFeatures,
    routedDomains,
    domainScores,
    vectorChunks,
  );
}

export async function hydrateChunksByIds(
  env: Env,
  chunkIds: string[],
): Promise<RetrievedChunk[]> {
  const chunks: RetrievedChunk[] = [];
  const seen = new Set<string>();

  for (const chunkId of chunkIds) {
    if (seen.has(chunkId)) {
      continue;
    }
    seen.add(chunkId);
    const stored = await env.ASSISTANT_CHUNKS?.get(chunkId, { type: "json" });
    const chunk = toRetrievedChunk(stored, 0);
    if (chunk) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

export async function debugRetrieveChunks(
  env: Env,
  normalizedQuery: string,
): Promise<RetrievalDebugReport> {
  const topK = parsePositiveInt(env.RETRIEVAL_TOP_K, DEFAULT_TOP_K, 20);
  const candidateK = parsePositiveInt(
    env.RETRIEVAL_CANDIDATE_K,
    DEFAULT_CANDIDATE_K,
    100,
  );
  const sampleKey = "wa3zat:ElTariqElDa5ely:0";
  const route = routeRetrievalDomains(normalizedQuery);
  const queryFeatures = createLexicalQueryFeatures(normalizedQuery);
  const explicitAl7anIntent = hasExplicitAl7anIntent(normalizedQuery);
  let routedDomains = enabledDomains(route.domains, env, explicitAl7anIntent);
  if (shouldDiscoverDomainsFromMetadata(queryFeatures, route.scores)) {
    const metadataCandidates = await retrieveMetadataCandidates(
      env,
      queryFeatures,
      candidateK,
    );
    routedDomains = enabledDomains(
      discoveredMetadataDomains(routedDomains, metadataCandidates),
      env,
      explicitAl7anIntent,
    );
  }
  const lexicalCorpora = await loadLexicalCorpora(env, routedDomains, normalizedQuery, route.scores);
  const sampleChunk = await env.ASSISTANT_CHUNKS?.get(sampleKey, { type: "json" });
  let lexicalCandidates = await retrieveLexicalCandidates(
    env,
    normalizedQuery,
    candidateK,
    routedDomains,
    route.scores,
  );

  let vectorCandidates: RetrievalCandidate[] = [];
  let embeddingLength = 0;
  let vectorError: string | undefined;
  try {
    const vectorDebug = await retrieveVectorCandidatesWithDebug(
      env,
      normalizedQuery,
      candidateK,
      routedDomains,
    );
    vectorCandidates = vectorDebug.candidates;
    embeddingLength = vectorDebug.embeddingLength;
  } catch (error) {
    vectorError = error instanceof Error ? error.message : String(error);
  }

  const vectorChunksForFallback = await hydrateCandidates(env, vectorCandidates, topK);
  if (shouldExpandEmptyDomainFallback(routedDomains, vectorChunksForFallback, lexicalCandidates)) {
    lexicalCandidates = await retrieveLexicalCandidates(
      env,
      normalizedQuery,
      candidateK,
      expandedEmptyDomainFallbackDomains(routedDomains),
      route.scores,
    );
  }

  const fused = fuseCandidates(
    [...vectorCandidates, ...lexicalCandidates],
    route.strictDomains ? { lexicalScoreWeight: 0, vectorRankWeight: 1.3 } : undefined,
  );
  const hydrated = await hydrateCandidates(env, fused, topK);
  const requestedIds = fused.slice(0, topK).map((candidate) => candidate.chunk_id);
  const hydratedIds = new Set(hydrated.map((chunk) => chunk.chunk_id));

  return {
    normalized_query: normalizedQuery,
    kv: {
      lexical_type: lexicalCorpora.every(Array.isArray) ? "array" : "other",
      lexical_count: lexicalCorpora.reduce((sum, corpus) => sum + corpus.length, 0),
      sample_key: sampleKey,
      sample_type: valueKind(sampleChunk),
    },
    lexical: {
      candidate_count: lexicalCandidates.length,
      top_ids: lexicalCandidates.slice(0, topK).map((candidate) => candidate.chunk_id),
    },
    vector: {
      candidate_count: vectorCandidates.length,
      top_ids: vectorCandidates.slice(0, topK).map((candidate) => candidate.chunk_id),
      embedding_length: embeddingLength,
      error: vectorError,
    },
    hydration: {
      requested_ids: requestedIds,
      hydrated_count: hydrated.length,
      missing_ids: requestedIds.filter((id) => !hydratedIds.has(id)),
    },
  };
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    return fallback;
  }

  return parsed;
}

function createLexicalQueryFeatures(normalizedQuery: string): LexicalQueryFeatures {
  const tokens = tokenize(normalizedQuery);
  return {
    normalizedQuery,
    tokens,
    phrases: buildQueryPhrases(tokens),
    compactQuery: compactSearchValue(normalizedQuery),
    looseTokens: tokens.map(stripInternalAlefs),
    coverageTokenGroups: coverageTokenGroups(normalizedQuery),
    rawTokenCount: rawTokenCount(normalizedQuery),
  };
}

async function retrieveVectorCandidates(
  env: Env,
  normalizedQuery: string,
  candidateK: number,
  routedDomains: SemanticDomain[],
  cpu?: AssistantCpuPhaseRecorder,
): Promise<RetrievalCandidate[]> {
  return (await retrieveVectorCandidatesWithDebug(env, normalizedQuery, candidateK, routedDomains, cpu))
    .candidates;
}

async function retrieveVectorCandidatesWithDebug(
  env: Env,
  normalizedQuery: string,
  candidateK: number,
  routedDomains: SemanticDomain[] = routeRetrievalDomains(normalizedQuery).domains,
  cpu?: AssistantCpuPhaseRecorder,
): Promise<{ candidates: RetrievalCandidate[]; embeddingLength: number }> {
  if (!env.ASSISTANT_AI || !env.ASSISTANT_VECTORIZE || !env.ASSISTANT_EMBEDDING_MODEL) {
    return { candidates: [], embeddingLength: 0 };
  }

  let vector: number[];
  try {
    const embeddingStartedAt = performance.now();
    const embeddingResponse = await env.ASSISTANT_AI.run(env.ASSISTANT_EMBEDDING_MODEL, {
      text: [normalizedQuery],
    });
    cpu?.addWallPhase?.("vector_embedding", performance.now() - embeddingStartedAt);
    vector = extractEmbedding(embeddingResponse);
  } catch {
    return { candidates: [], embeddingLength: 0 };
  }

  if (!vector.length) {
    return { candidates: [], embeddingLength: 0 };
  }

  const queryOptions = {
    topK: candidateK,
    returnMetadata: true,
    filter: vectorDomainFilter(routedDomains, env, normalizedQuery),
  };
  let result;
  try {
    const queryStartedAt = performance.now();
    result = await env.ASSISTANT_VECTORIZE.query(vector, queryOptions);
    cpu?.addWallPhase?.("vector_query", performance.now() - queryStartedAt);
  } catch (error) {
    const fallbackStartedAt = performance.now();
    result = await env.ASSISTANT_VECTORIZE.query(vector, {
      topK: candidateK,
      returnMetadata: true,
    });
    cpu?.addWallPhase?.("vector_query_fallback", performance.now() - fallbackStartedAt);
  }

  const mappingStartedAt = performance.now();
  const candidates = (result.matches ?? [])
    .filter((match): match is VectorizeMatch => typeof match.id === "string")
    .map((match, index) => ({
      chunk_id: match.id,
      rank: index + 1,
      source: "vector" as const,
      score: typeof match.score === "number" ? match.score : 0,
    }));
  cpu?.addPhase("vector_result_mapping", performance.now() - mappingStartedAt);

  return {
    candidates,
    embeddingLength: vector.length,
  };
}

function vectorDomainFilter(
  routedDomains: SemanticDomain[],
  env: Env,
  normalizedQuery: string,
): Record<string, unknown> | undefined {
  const filter: Record<string, unknown> = {};
  if (routedDomains.length) filter.semanticDomain = { $in: routedDomains };
  const excluded = excludedOptionalSources(env, normalizedQuery, routedDomains);
  if (excluded.length) filter.source_library = { $nin: excluded };
  return Object.keys(filter).length ? filter : undefined;
}

function extractEmbedding(response: unknown): number[] {
  const data = asRecord(response)?.data;
  if (Array.isArray(data) && Array.isArray(data[0])) {
    return data[0].filter(isFiniteNumber);
  }

  const vector = asRecord(response)?.vector;
  if (Array.isArray(vector)) {
    return vector.filter(isFiniteNumber);
  }

  return [];
}

function shouldUseMetadataFallback(
  routedDomains: SemanticDomain[],
  domainScores: DomainScores,
): boolean {
  if (routedDomains.includes("saints")) {
    return true;
  }
  if (hasConfidentTeachingRoute(domainScores)) {
    return false;
  }
  return routedDomains.includes("tari5") || routedDomains.includes("bible");
}

function shouldDiscoverDomainsFromMetadata(
  query: LexicalQueryFeatures,
  domainScores: DomainScores,
): boolean {
  if (Object.values(domainScores).some((score) => score > 0)) {
    return false;
  }

  const hasIdentityIntent = [
    "مين هو",
    "من هو",
    "مين هي",
    "من هي",
    "اتسمي",
    "لقب",
    "والي",
  ].some((term) => query.normalizedQuery.includes(normalizeArabicForSearch(term)));
  const hasProperNameShape =
    query.rawTokenCount <= 3 &&
    query.tokens.some((token) => stripArabicArticle(token).length >= 5);

  return hasIdentityIntent || hasProperNameShape;
}

function discoveredMetadataDomains(
  fallbackDomains: SemanticDomain[],
  candidates: RetrievalCandidate[],
): SemanticDomain[] {
  const bestScore = candidates[0]?.score ?? 0;
  if (bestScore < 30) {
    return fallbackDomains;
  }

  const minimumScore = Math.max(30, bestScore - 12);
  const domains = candidates
    .filter((candidate) => candidate.score >= minimumScore)
    .map((candidate) => candidate.semanticDomain)
    .filter((domain): domain is SemanticDomain => Boolean(domain));

  return domains.length ? [...new Set(domains)] : fallbackDomains;
}

function semanticDomainField(source: LexicalRecord): SemanticDomain | undefined {
  const domain = source.semanticDomain;
  return typeof domain === "string" &&
    ["al7an", "taqs", "tari5", "saints", "coptic", "bible", "ta3lim", "school"].includes(domain)
    ? domain as SemanticDomain
    : undefined;
}

async function retrieveMetadataCandidates(
  env: Env,
  queryFeatures: LexicalQueryFeatures,
  candidateK: number,
  cpu?: AssistantCpuPhaseRecorder,
): Promise<RetrievalCandidate[]> {
  const loadStartedAt = performance.now();
  const routedDomains = enabledDomains(routeRetrievalDomains(queryFeatures.normalizedQuery).domains, env);
  const metadataKeys = [METADATA_LEXICAL_KEY];
  const loaded = await Promise.all(metadataKeys.map(async (key) => {
    try {
      return await env.ASSISTANT_CHUNKS?.get(key, { type: "json" });
    } catch {
      return null;
    }
  }));
  const corpus = loaded.flatMap((value) => Array.isArray(value) ? value : []);
  cpu?.addWallPhase?.("metadata_load", performance.now() - loadStartedAt);
  if (!corpus.length) return [];

  const startedAt = performance.now();
  const seneksarDateKey = relativeSeneksarDateKey(queryFeatures.normalizedQuery);
  const candidates = corpus
    .filter(isLexicalRecord)
    .map((chunk) => {
      const dateMatch = Boolean(
        seneksarDateKey &&
        chunk.source_library === "seneksar" &&
        chunk.keywords?.includes(`seneksar-date:${seneksarDateKey}`)
      );
      return {
        chunk,
        score: scoreMetadataChunk(chunk, queryFeatures) + (dateMatch ? 1000 : 0),
        structuredMatch: dateMatch || hasMetadataIdentityMatch(chunk, queryFeatures),
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateK)
    .map((entry, index) => ({
      chunk_id: entry.chunk.chunk_id,
      rank: index + 1,
      source: "metadata" as const,
      score: entry.score,
      structuredMatch: entry.structuredMatch,
      semanticDomain: semanticDomainField(entry.chunk),
      sourceLibrary: entry.chunk.source_library,
    }));
  cpu?.addPhase("metadata_scoring", performance.now() - startedAt);
  return candidates;
}
async function retrieveLexicalCandidates(
  env: Env,
  queryFeatures: LexicalQueryFeatures | string,
  candidateK: number,
  routedDomains = routeRetrievalDomains(typeof queryFeatures === "string" ? queryFeatures : queryFeatures.normalizedQuery).domains,
  domainScores = routeRetrievalDomains(typeof queryFeatures === "string" ? queryFeatures : queryFeatures.normalizedQuery).scores,
  cpu?: AssistantCpuPhaseRecorder,
): Promise<RetrievalCandidate[]> {
  const corpus = (
    await loadLexicalCorpora(env, routedDomains, typeof queryFeatures === "string" ? queryFeatures : queryFeatures.normalizedQuery, domainScores, cpu)
  ).flat();
  if (!corpus.length) {
    return [];
  }

  const features = typeof queryFeatures === "string" ? createLexicalQueryFeatures(queryFeatures) : queryFeatures;
  const startedAt = performance.now();
  const candidates = corpus
    .map((chunk) => ({
      chunk,
      score: scoreLexicalChunk(chunk, features),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateK)
    .map((entry, index) => ({
      chunk_id: entry.chunk.chunk_id,
      rank: index + 1,
      source: "lexical" as const,
      score: entry.score,
      structuredMatch: hasStructuredLexicalMatch(entry.chunk, features),
      chunk: isStoredChunk(entry.chunk) ? entry.chunk : undefined,
    }));
  cpu?.addPhase("lexical_scoring", performance.now() - startedAt);
  return candidates;
}

async function loadLexicalCorpora(
  env: Env,
  routedDomains: SemanticDomain[],
  normalizedQuery: string,
  domainScores: DomainScores,
  cpu?: AssistantCpuPhaseRecorder,
): Promise<LexicalRecord[][]> {
  const keys = lexicalCorpusKeys(env, routedDomains, normalizedQuery, domainScores);
  const loadStartedAt = performance.now();
  const corpora = await Promise.all(
    keys.map(async (key) => {
      try {
        return await env.ASSISTANT_CHUNKS?.get(key, { type: "json" });
      } catch {
        return null;
      }
    }),
  );
  const loadedCorpora = corpora.map((corpus) => (Array.isArray(corpus) ? corpus.filter(isLexicalRecord) : []));

  cpu?.addWallPhase?.("lexical_load", performance.now() - loadStartedAt);

  return loadedCorpora;
}

function lexicalCorpusKeys(
  env: Env,
  routedDomains: SemanticDomain[],
  normalizedQuery: string,
  domainScores: DomainScores,
): string[] {
  const configured = env.ASSISTANT_LEXICAL_KEYS?.split(",")
    .map((key) => key.trim())
    .filter(Boolean);

  const baseKeys = configured?.length ? configured : DEFAULT_LEXICAL_CORPUS_KEYS;
  return [...new Set(baseKeys.flatMap((key) => {
    if (key === "lexical:domain") {
      const teachingRoute = routedDomains.includes("ta3lim") &&
        hasConfidentTeachingRoute(domainScores) &&
        !hasPositiveBibleRouteScore(domainScores);
      const keys = routedDomains
        .filter((domain) => !teachingRoute || domain !== "bible")
        .map((domain) => `${key}:${domain}`);
      if (teachingRoute) {
        keys.push("lexical:facet:sermon");
      }
      if (routedDomains.includes("bible")) {
        keys.push("lexical:facet:bible-summary-detail");
        if (hasVerseLookupIntent(normalizedQuery)) {
          keys.push("lexical:facet:verse");
        }
      }
      for (const source of eligibleOptionalSources(env, normalizedQuery, routedDomains)) {
        if (source === "aqwal") keys.push("lexical:facet:fathers");
        if (source === "cartoon") keys.push("lexical:facet:cartoon");
        if (source === "seneksar") keys.push("lexical:facet:seneksar");
      }
      return keys;
    }
    return key;
  }))];
}

function hasRitualBoundaryIntent(normalizedQuery: string): boolean {
  const terms = [
    "يبدأ",
    "يبدء",
    "بيبدأ",
    "بيبدء",
    "نبدأ",
    "نبدء",
    "يبتدي",
    "بيبتدي",
    "أول حاجة",
    "أول جزء",
    "ينتهي",
    "بينتهي",
    "يخلص",
    "بيخلص",
    "آخر حاجة",
    "آخر جزء",
  ];
  return terms.some((term) =>
    normalizedQuery.includes(normalizeArabicForSearch(term)),
  );
}

function hasVerseLookupIntent(normalizedQuery: string): boolean {
  const terms = [
    "verse",
    "verses",
    "آية",
    "آية بتقول",
    "آية اللي",
    "آيات",
    "شاهد",
    "الشاهد",
    "فين الآية",
    "معنى آية",
  ];
  const hasVerseTerm = terms.some((term) =>
    normalizedQuery.includes(normalizeArabicForSearch(term)),
  );
  const hasReferenceShape = /(?:^|\s)(?:[1-3]\s+)?[\p{L}]+\s+\d+\s+\d+(?:\s|$)/u.test(
    normalizedQuery,
  );
  return hasVerseTerm || hasReferenceShape;
}

function scoreMetadataChunk(chunk: LexicalRecord, query: LexicalQueryFeatures): number {
  const title = normalizeLexicalValue(chunk.title);
  const section = normalizeLexicalValue(chunk.section);
  const exactNameBoost = title === query.normalizedQuery || section === query.normalizedQuery ? 80 : 0;
  return exactNameBoost + scoreLexicalChunk({ ...chunk, text: undefined, search_text: undefined }, query);
}
function hasMetadataIdentityMatch(
  chunk: LexicalRecord,
  query: LexicalQueryFeatures,
): boolean {
  const identityValues = [
    chunk.title,
    chunk.section,
    joinedField(chunk.keywords),
    chunk.source_ref,
  ]
    .map((value) => normalizeLexicalValue(value))
    .filter(Boolean);

  return query.tokens
    .filter((token) => token.length >= 4)
    .some((token) =>
      identityValues.some(
        (value) =>
          value.includes(token) ||
          stripInternalAlefs(value).includes(stripInternalAlefs(token)),
      ),
    );
}

function scoreLexicalChunk(chunk: LexicalRecord, query: LexicalQueryFeatures): number {
  const shouldUseEnrichment = chunk.semanticDomain === "bible" || chunk.semanticDomain === "taqs";
  const haystacks = [
    { value: chunk.title, weight: 20 },
    { value: chunk.section, weight: 10 },
    { value: chunk.search_text, weight: 12 },
    { value: lexicalStringField(chunk, "detail_search_text"), weight: 18 },
    { value: chunk.summary, weight: 18 },
    { value: joinedField(chunk.categories), weight: 8 },
    { value: joinedField(chunk.keywords), weight: 20 },
    ...(shouldUseEnrichment
      ? [
        { value: joinedField(chunk.events), weight: 36, structured: true },
        { value: joinedField(chunk.aliases), weight: 36, structured: true },
        { value: joinedField(chunk.entities), weight: 24, structured: true },
        { value: joinedField(chunk.places), weight: 24, structured: true },
        { value: joinedField(chunk.symbols), weight: 20, structured: true },
        { value: joinedField(chunk.themes), weight: 16, structured: true },
        { value: joinedField(chunk.enriched_terms), weight: 12, structured: true },
      ]
      : []),
    { value: chunk.semanticDomain, weight: 8 },
    { value: joinedField(chunk.facets), weight: 8 },
    { value: joinedField(chunk.authors), weight: 6 },
  ];
  const tokens = query.tokens;
  const queryPhrases = query.phrases;
  let score = 0;

  for (const haystack of haystacks) {
    const value = normalizeLexicalValue(haystack.value);
    const compactValue = compactSearchValue(value);
    const looseValue = stripInternalAlefs(value);
    if (value.includes(query.normalizedQuery)) {
      score += haystack.weight;
    }
    for (const token of tokens) {
      const tokenFactor = lexicalTokenFactor(token);
      if (value.includes(token)) {
        score += Math.max(0.25, Math.floor(haystack.weight / 4) * tokenFactor);
      } else if (token.length >= 4 && looseValue.includes(stripInternalAlefs(token))) {
        score += Math.max(0.25, Math.floor(haystack.weight / 5) * tokenFactor);
      }
    }
    for (const phrase of queryPhrases) {
      if (value.includes(phrase)) {
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

  score += queryCoveragePrior(haystacks, query.coverageTokenGroups);
  score += titleCoveragePrior(chunk, tokens);

  if (isBroadTitleQuery(chunk, query.normalizedQuery, tokens)) {
    score += BROAD_TITLE_INTRO_PRIOR / (chunkOrdinal(chunk.chunk_id) + 1);
  }

  return score;
}

function queryCoveragePrior(
  haystacks: Array<{ value: unknown }>,
  coverageGroups: string[][],
): number {
  if (!coverageGroups.length) {
    return 0;
  }

  const values = haystacks.map((haystack) => normalizeLexicalValue(haystack.value as string | undefined));
  const matched = coverageGroups.filter((group) =>
    group.some((token) =>
      values.some((value) => value.includes(token) || stripInternalAlefs(value).includes(stripInternalAlefs(token))),
    ),
  ).length;
  if (!matched) {
    return 0;
  }

  const coverage = matched / coverageGroups.length;
  return matched * 12 + (coverage >= 1 ? 80 : coverage >= 0.75 ? 28 : 0);
}

function titleCoveragePrior(chunk: LexicalRecord, queryTokens: string[]): number {
  const titleTokens = tokenize(normalizeLexicalValue(chunk.title));
  if (!titleTokens.length) {
    return 0;
  }

  const queryTokenSet = new Set(queryTokens);
  const matched = titleTokens.filter((token) => queryTokenSet.has(token)).length;
  const coverage = matched / titleTokens.length;

  if (coverage >= 1) {
    return 40;
  }
  if (coverage >= 0.5) {
    return 18 * coverage;
  }
  return 0;
}

function buildQueryPhrases(tokens: string[]): string[] {
  const phrases = new Set<string>();
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

function compactSearchValue(value: string): string {
  return value.replace(/\s+/g, "");
}

function stripInternalAlefs(value: string): string {
  return value
    .split(/\s+/)
    .map((token) => {
      const looseToken = token.replace(/ء$/, "ا");
      if (looseToken.length < 4) return looseToken;
      return `${looseToken[0]}${looseToken.slice(1).replace(/ا/g, "")}`;
    })
    .join(" ");
}

function isBroadTitleQuery(
  chunk: LexicalRecord,
  normalizedQuery: string,
  queryTokens: string[],
): boolean {
  const title = normalizeLexicalValue(chunk.title);
  const titleTokens = tokenize(title);
  if (!titleTokens.length) {
    return false;
  }

  const titleMatches =
    normalizedQuery.includes(title) ||
    titleTokens.every((token) => queryTokens.includes(token));
  if (!titleMatches) {
    return false;
  }

  const sectionTokens = tokenize(normalizeLexicalValue(chunk.section));
  return !sectionTokens.some((token) => queryTokens.includes(token));
}

function normalizeLexicalValue(value: string | undefined): string {
  return normalizeArabicForSearch(value ?? "").toLowerCase();
}

function coverageTokenGroups(value: string): string[][] {
  return value
    .split(/\s+/)
    .filter((token) => token.length > 1 && !QUERY_STOPWORDS.has(token))
    .map((token) => tokenVariants(token).filter((variant) => variant.length > 1))
    .filter((group) => group.length > 0);
}

function tokenize(value: string): string[] {
  const tokens = value.split(/\s+/).filter((token) => token.length > 1);
  return [...new Set(tokens.flatMap(tokenVariants))].filter(
    (token) => token.length > 1 && !QUERY_STOPWORDS.has(token),
  );
}

function tokenVariants(token: string): string[] {
  const variants = new Set([token, stripArabicArticle(token)]);
  const withoutProclitic = stripArabicProclitic(token);
  variants.add(withoutProclitic);
  variants.add(stripArabicArticle(withoutProclitic));
  return [...variants];
}

function stripArabicArticle(token: string): string {
  if (token.startsWith("ال") && token.length > 3) {
    return token.slice(2);
  }
  return token;
}

function stripArabicProclitic(token: string): string {
  if (token.length <= 4) {
    return token;
  }
  const first = token[0];
  if (["ب", "ف", "ك", "ل", "و"].includes(first) && token.slice(1).startsWith("ال")) {
    return token.slice(1);
  }
  return token;
}

function lexicalTokenFactor(token: string): number {
  return LOW_SIGNAL_TERMS.has(token) ? 0.25 : 1;
}

function joinedField(value: string[] | undefined): string {
  return Array.isArray(value) ? value.join(" ") : "";
}

function lexicalStringField(source: LexicalRecord, key: string): string | undefined {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function hasExactRetrievalIntent(
  queryFeatures: LexicalQueryFeatures,
  routedDomains: SemanticDomain[],
  domainScores: DomainScores,
  vectorChunks: RetrievedChunk[],
): boolean {
  const tokens = queryFeatures.tokens;
  if (hasExactTitleIntent(tokens, queryFeatures.normalizedQuery, queryFeatures.rawTokenCount, vectorChunks)) {
    return true;
  }
  const titleOverlap = bestVectorTitleQueryCoverage(tokens, vectorChunks);
  if (queryFeatures.rawTokenCount <= 3 && titleOverlap < 0.25) {
    return true;
  }
  if (
    !hasPositiveBibleRouteScore(domainScores) &&
    vectorChunks.some((chunk) => isBibleChunk(chunk))
  ) {
    return true;
  }

  if (hasPositiveBibleRouteScore(domainScores) && titleOverlap < 0.25) {
    return true;
  }

  if (routedDomains.includes("ta3lim") && titleOverlap < 0.5) {
    return true;
  }

  return false;
}

function lexicalFallbackDomains(
  routedDomains: SemanticDomain[],
  vectorCandidates: RetrievalCandidate[],
): SemanticDomain[] {
  if (!vectorCandidates.length) {
    return routedDomains;
  }
  return routedDomains;
}

function shouldExpandEmptyDomainFallback(
  routedDomains: SemanticDomain[],
  vectorChunks: RetrievedChunk[],
  lexicalCandidates: RetrievalCandidate[],
): boolean {
  return (
    vectorChunks.length === 0 &&
    lexicalCandidates.length === 0 &&
    routedDomains.some((domain) => EMPTY_DOMAIN_FALLBACKS[domain]?.length)
  );
}

function expandedEmptyDomainFallbackDomains(routedDomains: SemanticDomain[]): SemanticDomain[] {
  const domains = new Set<SemanticDomain>(routedDomains);
  for (const domain of routedDomains) {
    for (const fallback of EMPTY_DOMAIN_FALLBACKS[domain] ?? []) {
      domains.add(fallback);
    }
  }
  return [...domains];
}

function isBibleChunk(chunk: RetrievedChunk): boolean {
  return chunk.semanticDomain === "bible" || chunk.chunk_id.startsWith("bible-summary:");
}

function isBibleLexicalCandidate(candidate: RetrievalCandidate): boolean {
  return candidate.chunk_id.startsWith("bible-summary:") || candidate.chunk_id.startsWith("verse:");
}

function hasStrongStructuredLexicalMatch(
  candidate: RetrievalCandidate,
  query: LexicalQueryFeatures,
): boolean {
  void query;
  return candidate.score >= LEXICAL_STRONG_SCORE_THRESHOLD && candidate.structuredMatch === true;
}

function hasStructuredLexicalMatch(
  chunk: LexicalRecord,
  query: LexicalQueryFeatures,
): boolean {
  return query.coverageTokenGroups.some((group) =>
    structuredLexicalValues(chunk).some((value) =>
      group.some(
        (token) =>
          value.includes(token) ||
          stripInternalAlefs(value).includes(stripInternalAlefs(token)),
      ),
    ),
  );
}

function structuredLexicalValues(chunk: Partial<StoredChunk>): string[] {
  return [
    chunk.events,
    chunk.aliases,
    chunk.entities,
    chunk.places,
    chunk.symbols,
    chunk.themes,
    chunk.enriched_terms,
  ]
    .map((value) => normalizeLexicalValue(joinedField(value)))
    .filter(Boolean);
}

function hasTopNonBibleVectorResult(vectorChunks: RetrievedChunk[]): boolean {
  const topVectorChunk = vectorChunks[0];
  return Boolean(topVectorChunk && !isBibleChunk(topVectorChunk));
}

function hasConfidentTeachingRoute(domainScores: DomainScores): boolean {
  return (domainScores.ta3lim ?? 0) >= 2;
}

function hasPositiveBibleRouteScore(domainScores: DomainScores): boolean {
  return (domainScores.bible ?? 0) > 0;
}

function rawTokenCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

function hasExactTitleIntent(
  queryTokens: string[],
  normalizedQuery: string,
  queryRawTokenCount: number,
  vectorChunks: RetrievedChunk[],
): boolean {
  for (const chunk of vectorChunks) {
    const title = normalizeLexicalValue(chunk.title);
    const titleTokens = tokenize(title);
    if (!titleTokens.length) continue;

    const titleCovered = titleTokens.every((token) => queryTokens.includes(token));
    if (!titleCovered) continue;

    if (normalizedQuery === title || queryRawTokenCount <= rawTokenCount(title)) {
      return true;
    }
  }

  return false;
}

function bestVectorTitleQueryCoverage(
  queryTokens: string[],
  vectorChunks: RetrievedChunk[],
): number {
  if (!queryTokens.length) return 0;
  const queryTokenSet = new Set(queryTokens);
  return vectorChunks.reduce((best, chunk) => {
    const titleTokens = tokenize(normalizeLexicalValue(chunk.title));
    if (!titleTokens.length) return best;
    const matched = titleTokens.filter((token) => queryTokenSet.has(token)).length;
    return Math.max(best, matched / queryTokens.length);
  }, 0);
}

function chunkOrdinal(chunkId: string): number {
  const rawOrdinal = chunkId.split(":").at(-1);
  const ordinal = Number(rawOrdinal);
  return Number.isInteger(ordinal) && ordinal >= 0 ? ordinal : 0;
}

function fuseCandidates(
  candidates: RetrievalCandidate[],
  options: { lexicalScoreWeight?: number; vectorRankWeight?: number } = {},
): RetrievalCandidate[] {
  const byId = new Map<string, RetrievalCandidate & { fusedScore: number }>();
  const lexicalScoreWeight = options.lexicalScoreWeight ?? LEXICAL_SCORE_WEIGHT;
  const vectorRankWeight = options.vectorRankWeight ?? 1;

  for (const candidate of candidates) {
    const lexicalBoost =
      candidate.source !== "vector" ? candidate.score * lexicalScoreWeight : 0;
    const rankWeight = candidate.source === "vector" ? vectorRankWeight : 1;
    const fusedScore = rankWeight / (RRF_K + candidate.rank) + lexicalBoost;
    const current = byId.get(candidate.chunk_id);

    if (!current) {
      byId.set(candidate.chunk_id, { ...candidate, fusedScore });
      continue;
    }

    current.fusedScore += fusedScore;
    current.score = Math.max(current.score, candidate.score);
    current.chunk ??= candidate.chunk;
  }

  return [...byId.values()].sort((a, b) => b.fusedScore - a.fusedScore);
}

async function hydrateCandidates(
  env: Env,
  candidates: RetrievalCandidate[],
  limit: number,
  cpu?: AssistantCpuPhaseRecorder,
  phaseName = "hydration_wall",
  cache?: Map<string, unknown>,
): Promise<RetrievedChunk[]> {
  const startedAt = performance.now();
  const chunks: RetrievedChunk[] = [];

  for (const candidate of candidates) {
    let stored: unknown = candidate.chunk ?? cache?.get(candidate.chunk_id);
    if (!stored) {
      try {
        stored = await env.ASSISTANT_CHUNKS?.get(candidate.chunk_id, { type: "json" });
        if (stored) {
          cache?.set(candidate.chunk_id, stored);
        }
      } catch {
        stored = null;
      }
    }
    const chunk = toRetrievedChunk(stored, candidate.score);
    if (chunk) {
      chunks.push(chunk);
    }
    if (chunks.length >= limit) {
      break;
    }
  }

  cpu?.addWallPhase?.(phaseName, performance.now() - startedAt);
  return chunks;
}

function toRetrievedChunk(value: unknown, score: number): RetrievedChunk | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const docId = stringField(record, "doc_id");
  const chunkId = stringField(record, "chunk_id");
  const title = stringField(record, "title");
  const url = stringField(record, "url");
  const text = stringField(record, "text");

  if (!docId || !chunkId || !title || !url || !text) {
    return null;
  }

  return {
    doc_id: docId,
    chunk_id: chunkId,
    title,
    url,
    text,
    score,
    content_type: stringField(record, "content_type"),
    library: stringField(record, "library"),
    source_library: stringField(record, "source_library"),
    section: stringField(record, "section"),
    language: stringField(record, "language"),
    semanticDomain: stringField(record, "semanticDomain"),
    facets: stringArrayField(record, "facets"),
  };
}

function isStoredChunk(value: unknown): value is StoredChunk {
  const record = asRecord(value);
  return Boolean(
    record &&
    stringField(record, "doc_id") &&
    stringField(record, "chunk_id") &&
    stringField(record, "title") &&
    stringField(record, "url") &&
    stringField(record, "text"),
  );
}

function isLexicalRecord(value: unknown): value is LexicalRecord {
  const record = asRecord(value);
  return Boolean(
    record &&
    stringField(record, "doc_id") &&
    stringField(record, "chunk_id") &&
    stringField(record, "title") &&
    stringField(record, "url"),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function stringArrayField(source: Record<string, unknown>, key: string): string[] | undefined {
  const value = source[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function valueKind(value: unknown): "array" | "object" | "string" | "null" | "other" {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "object") return "object";
  return "other";
}
