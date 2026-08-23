import type { AssistantAnswerDebug, AssistantMessageResponse, AssistantQuotaMetadata, AssistantTranslationDebug, DetectedLanguage, RetrievedChunk, SupportedLanguage } from "./types";
import type { ValidatedGroundedAnswer } from "./answer";

type RetrievalOnlyResponseInput = {
  conversationId?: string;
  quota?: AssistantQuotaMetadata;
  query: string;
  normalizedQuery: string;
  chunks: RetrievedChunk[];
  answerDebug?: AssistantAnswerDebug;
  includeFullRetrievedChunks?: boolean;
  detectedLanguage?: DetectedLanguage;
  answerLanguage?: SupportedLanguage;
  translationDebug?: AssistantTranslationDebug;
};

type FallbackReason =
  | "fallback_only_mode"
  | "actor_daily_quota"
  | "network_daily_quota"
  | "evaluation_daily_quota"
  | "quota_identity_unavailable"
  | "quota_storage_unavailable"
  | "device_daily_quota"
  | "global_daily_quota"
  | "global_monthly_quota"
  | "monthly_budget"
  | "model_provider_error"
  | "retrieval_error";

type FallbackMode = "search_only" | "sources_with_search";

const MIN_HANDOFF_SOURCE_SCORE = 0.5;
const DEFAULT_PUBLIC_SITE_URL = "https://example.com";

function publicSiteUrl(value?: string): string {
  return (value?.trim() || DEFAULT_PUBLIC_SITE_URL).replace(/\/$/, "");
}

type FallbackResponseInput = RetrievalOnlyResponseInput & {
  fallbackReason: FallbackReason;
  fallbackMode?: FallbackMode;
  siteUrl?: string;
};

export function createRetrievalOnlyResponse(
  input: RetrievalOnlyResponseInput,
): AssistantMessageResponse {
  return {
    message_id: crypto.randomUUID(),
    conversation_id: input.conversationId,
    answer: "",
    citations: input.chunks.map((chunk) => ({
      title: chunk.title,
      url: chunk.url,
      snippet: createSnippet(chunk.text),
    })),
    suggested_actions: uniqueByUrl(input.chunks).map((chunk) => ({
      type: "navigate_to_url",
      label: chunk.title,
      url: chunk.url,
    })),
    confidence: "retrieval_only",
    detected_language: input.detectedLanguage ?? "ar",
    answer_language: input.answerLanguage ?? "ar",
    retrieved_chunks: responseChunks(input.chunks, input.includeFullRetrievedChunks === true),
    quota: input.quota,
    debug: {
      query: input.query,
      normalized_query: input.normalizedQuery,
      retrieval_mode: "controlled_hybrid",
      answer: input.answerDebug,
      translation: input.translationDebug,
    },
  };
}


export function createFallbackAnswerResponse(
  input: FallbackResponseInput,
): AssistantMessageResponse {
  const fallbackMode = input.fallbackMode ?? "sources_with_search";
  const includeSources = fallbackMode === "sources_with_search";
  const sourceActions = includeSources
    ? uniqueByUrl(input.chunks).map((chunk) => ({
      type: "navigate_to_url" as const,
      label: chunk.title,
      url: chunk.url,
    }))
    : [];

  return {
    message_id: crypto.randomUUID(),
    conversation_id: input.conversationId,
    answer: fallbackMessage(input.fallbackReason, fallbackMode, input.answerLanguage ?? "ar"),
    citations: includeSources
      ? input.chunks.map((chunk) => ({
        title: chunk.title,
        url: chunk.url,
        snippet: createSnippet(chunk.text),
      }))
      : [],
    suggested_actions: uniqueActionsByUrl([
      ...sourceActions,
      {
        type: "navigate_to_url" as const,
        label: input.answerLanguage === "en" ? "Search the site" : "بحث في الموقع",
        url: `${publicSiteUrl(input.siteUrl)}/search.php`,
      },
    ]),
    confidence: "retrieval_only",
    detected_language: input.detectedLanguage ?? "ar",
    answer_language: input.answerLanguage ?? "ar",
    retrieved_chunks: responseChunks(input.chunks, input.includeFullRetrievedChunks === true),
    quota: input.quota,
    debug: {
      query: input.query,
      normalized_query: input.normalizedQuery,
      retrieval_mode: "controlled_hybrid",
      answer: {
        mode: "fallback",
        reason: input.fallbackReason,
      },
      translation: input.translationDebug,
    },
  };
}
export function createGroundedAnswerResponse(
  input: RetrievalOnlyResponseInput & {
    groundedAnswer: ValidatedGroundedAnswer;
  },
): AssistantMessageResponse {
  const handoffSourceChunks = handoffSourceChunksFor(input);
  const citedChunks = input.chunks.filter((chunk) =>
    input.groundedAnswer.cited_chunk_ids.includes(chunk.chunk_id),
  );
  const actionChunks = citedChunks.length > 0 ? citedChunks : handoffSourceChunks;
  const citations = input.groundedAnswer.citations.length > 0
    ? uniqueCitationsByUrl(input.groundedAnswer.citations)
    : handoffSourceChunks.map((chunk) => ({
      title: chunk.title,
      url: chunk.url,
      snippet: createSnippet(chunk.text),
    }));

  return {
    message_id: crypto.randomUUID(),
    conversation_id: input.conversationId,
    answer: input.groundedAnswer.answer,
    citations,
    suggested_actions: uniqueByUrl(actionChunks).map((chunk) => ({
      type: "navigate_to_url",
      label: chunk.title,
      url: chunk.url,
    })),
    confidence: input.groundedAnswer.confidence,
    detected_language: input.detectedLanguage ?? "ar",
    answer_language: input.answerLanguage ?? "ar",
    retrieved_chunks: responseChunks(input.chunks, input.includeFullRetrievedChunks === true),
    quota: input.quota,
    debug: {
      query: input.query,
      normalized_query: input.normalizedQuery,
      retrieval_mode: "controlled_hybrid",
      answer: input.answerDebug,
      translation: input.translationDebug,
    },
  };
}

function handoffSourceChunksFor(
  input: RetrievalOnlyResponseInput & { groundedAnswer: ValidatedGroundedAnswer },
): RetrievedChunk[] {
  if (input.answerDebug?.mode !== "handoff" || input.groundedAnswer.cited_chunk_ids.length > 0) {
    return [];
  }

  return uniqueByUrl(input.chunks.filter((chunk) => chunk.score >= MIN_HANDOFF_SOURCE_SCORE));
}

function responseChunks(
  chunks: RetrievedChunk[],
  includeFullRetrievedChunks: boolean,
): AssistantMessageResponse["retrieved_chunks"] {
  if (includeFullRetrievedChunks) {
    return chunks;
  }

  return chunks.map((chunk) => ({
    doc_id: chunk.doc_id,
    chunk_id: chunk.chunk_id,
    title: chunk.title,
    url: chunk.url,
    content_type: chunk.content_type,
    library: chunk.library,
    section: chunk.section,
    language: chunk.language,
    semanticDomain: chunk.semanticDomain,
    facets: chunk.facets,
  }));
}

function fallbackMessage(reason: FallbackReason, fallbackMode: FallbackMode, answerLanguage: SupportedLanguage): string {
  if (answerLanguage === "en") {
    if (fallbackMode === "search_only") {
      if (reason === "fallback_only_mode" || reason === "model_provider_error" || reason === "retrieval_error" || reason === "quota_identity_unavailable" || reason === "quota_storage_unavailable") {
        return "Questions are unavailable right now. You can use site search until the service is back.";
      }
      return "You've reached today's question limit. You can continue with site search.";
    }
    if (reason === "fallback_only_mode" || reason === "model_provider_error" || reason === "retrieval_error" || reason === "quota_identity_unavailable" || reason === "quota_storage_unavailable") {
      return "The smart answer is unavailable right now, but these are the closest sources that may help.";
    }
    return "You've reached today's smart answer limit, but these are the closest sources that may help.";
  }
  if (fallbackMode === "search_only") {
    if (reason === "fallback_only_mode" || reason === "model_provider_error" || reason === "retrieval_error" || reason === "quota_identity_unavailable" || reason === "quota_storage_unavailable") {
      return "الأسئلة مش متاحة دلوقتي. تقدر تستخدم بحث الموقع لحد ما ترجع الخدمة.";
    }
    return "وصلت للحد اليومي للأسئلة. تقدر تكمل باستخدام بحث الموقع.";
  }

  if (reason === "fallback_only_mode" || reason === "model_provider_error" || reason === "retrieval_error" || reason === "quota_identity_unavailable" || reason === "quota_storage_unavailable") {
    return "الإجابة الذكية مش متاحة دلوقتي، لكن دي أقرب مصادر ممكن تساعدك.";
  }
  return "وصلت للحد اليومي للإجابات الذكية، لكن دي أقرب مصادر ممكن تساعدك.";
}

function uniqueActionsByUrl(
  actions: AssistantMessageResponse["suggested_actions"],
): AssistantMessageResponse["suggested_actions"] {
  const seen = new Set<string>();
  const unique: AssistantMessageResponse["suggested_actions"] = [];
  for (const action of actions) {
    if (!seen.has(action.url)) {
      seen.add(action.url);
      unique.push(action);
    }
  }
  return unique;
}
function createSnippet(text: string): string {
  return text.trim().slice(0, 280);
}

function uniqueByUrl(chunks: RetrievedChunk[]): RetrievedChunk[] {
  const seen = new Set<string>();
  const unique: RetrievedChunk[] = [];

  for (const chunk of chunks) {
    if (!seen.has(chunk.url)) {
      seen.add(chunk.url);
      unique.push(chunk);
    }
  }

  return unique;
}

function uniqueCitationsByUrl(
  citations: ValidatedGroundedAnswer["citations"],
): ValidatedGroundedAnswer["citations"] {
  const seen = new Set<string>();
  const unique: ValidatedGroundedAnswer["citations"] = [];

  for (const citation of citations) {
    if (!seen.has(citation.url)) {
      seen.add(citation.url);
      unique.push(citation);
    }
  }

  return unique;
}
