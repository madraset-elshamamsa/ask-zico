import { buildAnswerContext, parseAnswerContextOptions } from "./answer-context";
import { estimateModelCostUsd } from "./economics";
import { reserveGeminiModelQuota, reserveOpenRouterQuota } from "./model-quota";
import type { AnswerContext } from "./answer-context";
import type {
  AssistantAnswerDebug,
  AssistantAnswerFailureReason,
  Citation,
  Confidence,
  Env,
  RetrievedChunk,
  AssistantFollowUpContext,
  AssistantLlmFetch,
} from "./types";

const DEFAULT_LLM_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash-lite";
const DEFAULT_GEMINI_MAX_ATTEMPTS = 3;
const MAX_GEMINI_MODEL_ATTEMPTS = 5;
const DEFAULT_CONFIDENCE: Confidence = "medium";
const MIN_CHUNK_TEXT_LENGTH = 40;
const MAX_MODEL_ATTEMPTS = 2;
const DEFAULT_MAX_OUTPUT_TOKENS = 700;
const DEFAULT_PROGRESSIVE_CONTEXT_BATCHES = [1, 2, 2];
const INCOMPLETE_ANSWER_ENDINGS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "because",
  "but",
  "by",
  "for",
  "from",
  "he",
  "in",
  "is",
  "of",
  "on",
  "or",
  "she",
  "that",
  "the",
  "then",
  "to",
  "was",
  "were",
  "with",
  "أن",
  "إن",
  "إلى",
  "او",
  "أو",
  "اللي",
  "ان",
  "الى",
  "إذ",
  "اذا",
  "إذا",
  "ب",
  "بعد",
  "بسبب",
  "بس",
  "ثم",
  "حتى",
  "على",
  "عن",
  "في",
  "قبل",
  "كان",
  "كانت",
  "كما",
  "لكن",
  "لأن",
  "لان",
  "لما",
  "لو",
  "ما",
  "مع",
  "من",
  "و",
]);
const INCOMPLETE_ANSWER_TRAILING_PATTERN = /(?:[,;:،؛:]|\.\.\.|…|\-)$/;
const HANDOFF_MESSAGE =
  "مش لاقي في المصادر المتاحة إجابة مؤكدة على السؤال ده. الأفضل تراجع صفحة المصدر أو تسأل خادم مختص عشان المعلومة تكون دقيقة.";

type GroundedAnswerInput = {
  query: string;
  chunks: RetrievedChunk[];
  followUp?: AssistantFollowUpContext;
};

type ModelAnswerStatus = "ANSWERED" | "NOT_FOUND_IN_BATCH";

type ModelAnswer = {
  status?: unknown;
  answer?: unknown;
  cited_chunk_ids?: unknown;
  confidence?: unknown;
};

type ModelProvider = "gemini" | "openrouter";

type ProviderAttempt = {
  provider: ModelProvider;
  model: string;
  ok: boolean;
  reason?: AssistantAnswerFailureReason;
  status?: number;
  fallback_reason?: string;
};

type ModelCallSuccess = {
  ok: true;
  content: string;
  provider: ModelProvider;
  modelName: string;
  attempts: number;
  fallbackReason?: string;
  providerAttempts: ProviderAttempt[];
};

type ModelCallFailure = {
  ok: false;
  reason: AssistantAnswerFailureReason;
  status?: number;
  attempts: number;
  fallbackReason?: string;
  providerAttempts: ProviderAttempt[];
};

export type ValidatedGroundedAnswer = {
  answer: string;
  citations: Citation[];
  cited_chunk_ids: string[];
  confidence: Confidence;
};

export type GroundedAnswerResult =
  | {
    ok: true;
    answer: ValidatedGroundedAnswer;
    debug: AssistantAnswerDebug;
  }
  | {
    ok: false;
    reason: AssistantAnswerFailureReason;
    status?: number;
    debug: AssistantAnswerDebug;
  };

export function hasStrongRetrieval(chunks: RetrievedChunk[]): boolean {
  return chunks.some((chunk) => chunk.text.trim().length >= MIN_CHUNK_TEXT_LENGTH);
}

export async function createGroundedAnswer(
  env: Env,
  input: GroundedAnswerInput,
): Promise<GroundedAnswerResult> {
  if (!hasStrongRetrieval(input.chunks)) {
    return failure("weak_retrieval");
  }

  if (!hasAnyModelProvider(env)) {
    return failure("missing_config");
  }

  const llmFetch: AssistantLlmFetch = env.ASSISTANT_LLM_FETCH ?? ((request, init) => fetch(request, init));
  const progressive = progressiveContextEnabled(env);
  const contextBatches = createContextBatches(env, input.chunks);
  let totalAttempts = 0;
  let batchAttempts = 0;

  for (const batchChunks of contextBatches) {
    if (!hasStrongRetrieval(batchChunks)) {
      continue;
    }

    batchAttempts += 1;
    const answerContext = buildAnswerContext({
      env,
      query: input.query,
      chunks: input.chunks,
      selectedChunks: batchChunks,
    });
    let retryReason: AssistantAnswerFailureReason | null = null;

    for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
      const modelCall = await callAnswerModel({
        env,
        fetchImpl: llmFetch,
        input,
        answerContext,
        retryReason,
      });
      totalAttempts += modelCall.attempts;
      if (!modelCall.ok) {
        return failure(
          modelCall.reason,
          modelCall.status,
          totalAttempts,
          progressive ? batchAttempts : undefined,
          modelCall.fallbackReason,
          modelCall.providerAttempts,
        );
      }

      const content = modelCall.content;

      const parsed = parseModelAnswer(content);
      if (!parsed) {
        if (attempt < MAX_MODEL_ATTEMPTS) {
          retryReason = "invalid_json";
          continue;
        }
        return failure("invalid_json", undefined, totalAttempts, progressive ? batchAttempts : undefined);
      }

      if (parseModelAnswerStatus(parsed.status) === "NOT_FOUND_IN_BATCH") {
        break;
      }

      const answer = validateModelAnswer(parsed, batchChunks, answerContext.resolveCitationId);
      if (!answer) {
        return failure("no_valid_citations", undefined, totalAttempts, progressive ? batchAttempts : undefined);
      }

      if (isIncompleteAnswer(answer.answer)) {
        if (attempt < MAX_MODEL_ATTEMPTS) {
          retryReason = "incomplete_answer";
          continue;
        }
        return failure("incomplete_answer", undefined, totalAttempts, progressive ? batchAttempts : undefined);
      }

      return {
        ok: true,
        answer,
        debug: {
          mode: "grounded",
          ...answerContext.debug,
          model_provider: modelCall.provider,
          model_name: modelCall.modelName,
          ...(modelCall.fallbackReason ? { provider_fallback_reason: modelCall.fallbackReason } : {}),
          provider_attempts: modelCall.providerAttempts,
          estimated_model_cost_usd: modelCall.provider === "gemini" ? 0 : estimateModelCostUsd(env),
          ...(progressive || totalAttempts > 1 ? { attempts: totalAttempts } : {}),
          ...(progressive ? { batch_attempts: batchAttempts } : {}),
        },
      };
    }
  }

  return failure(
    "not_found_in_context",
    undefined,
    totalAttempts || undefined,
    progressive ? batchAttempts : undefined,
  );
}

export function createHandoffAnswer(): ValidatedGroundedAnswer {
  return {
    answer: HANDOFF_MESSAGE,
    citations: [],
    cited_chunk_ids: [],
    confidence: "low",
  };
}

function progressiveContextEnabled(env: Env): boolean {
  return env.ASSISTANT_PROGRESSIVE_CONTEXT_ENABLED === "true";
}

function createContextBatches(env: Env, chunks: RetrievedChunk[]): RetrievedChunk[][] {
  if (!progressiveContextEnabled(env)) {
    return [chunks];
  }

  const topK = parseAnswerContextOptions(env).topK;
  const availableChunks = chunks.slice(0, topK);
  const batchSizes = parseProgressiveBatchSizes(env.ASSISTANT_CONTEXT_BATCHES);
  const batches: RetrievedChunk[][] = [];
  let offset = 0;

  for (const size of batchSizes) {
    if (offset >= availableChunks.length) {
      break;
    }
    const batch = availableChunks.slice(offset, offset + size);
    if (batch.length) {
      batches.push(batch);
    }
    offset += size;
  }

  return batches.length ? batches : [availableChunks];
}

function parseProgressiveBatchSizes(value: string | undefined): number[] {
  const parsed = (value ?? "")
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isInteger(item) && item > 0 && item <= 8);
  return parsed.length ? parsed : DEFAULT_PROGRESSIVE_CONTEXT_BATCHES;
}


function hasAnyModelProvider(env: Env): boolean {
  const hasGemini = Boolean(env.ASSISTANT_GEMINI_API_KEY);
  const hasOpenRouter = Boolean(env.ASSISTANT_LLM_API_KEY ?? env.OPENROUTER_API_KEY);
  return hasGemini || hasOpenRouter;
}

async function callAnswerModel(input: {
  env: Env;
  fetchImpl: AssistantLlmFetch;
  input: GroundedAnswerInput;
  answerContext: AnswerContext;
  retryReason: AssistantAnswerFailureReason | null;
}): Promise<ModelCallSuccess | ModelCallFailure> {
  let fallbackReason: string | undefined;
  let attempts = 0;
  let providerAttempts: ProviderAttempt[] = [];

  if (input.env.ASSISTANT_GEMINI_API_KEY) {
    const gemini = await callGeminiProvider(input);
    attempts += gemini.attempts;
    providerAttempts = [...providerAttempts, ...gemini.providerAttempts];
    if (gemini.ok) {
      return { ...gemini, attempts, providerAttempts };
    }

    fallbackReason = gemini.fallbackReason;
    if (!isProviderFallbackFailure(gemini)) {
      return { ...gemini, attempts, fallbackReason, providerAttempts };
    }
  }

  if (input.env.ASSISTANT_LLM_API_KEY ?? input.env.OPENROUTER_API_KEY) {
    const openRouter = await callOpenRouterProvider(input);
    attempts += openRouter.attempts;
    providerAttempts = [...providerAttempts, ...openRouter.providerAttempts];
    if (openRouter.ok) {
      return { ...openRouter, attempts, fallbackReason, providerAttempts };
    }
    return {
      ...openRouter,
      attempts,
      fallbackReason: fallbackReason ?? openRouter.fallbackReason,
      providerAttempts,
    };
  }

  return {
    ok: false,
    reason: "missing_config",
    attempts,
    fallbackReason,
    providerAttempts,
  };
}
async function callGeminiProvider(input: {
  env: Env;
  fetchImpl: AssistantLlmFetch;
  input: GroundedAnswerInput;
  answerContext: AnswerContext;
  retryReason: AssistantAnswerFailureReason | null;
}): Promise<ModelCallSuccess | ModelCallFailure> {
  const apiKey = input.env.ASSISTANT_GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "missing_config", attempts: 0, providerAttempts: [] };
  }

  const baseUrl = (input.env.ASSISTANT_GEMINI_BASE_URL ?? DEFAULT_GEMINI_BASE_URL).replace(/\/$/, "");
  const staticModels = parseGeminiModelAttempts(input.env);
  const quotaRouting = input.env.ASSISTANT_GEMINI_QUOTA_ROUTING_ENABLED === "true";
  const providerAttempts: ProviderAttempt[] = [];
  const excludedModels: string[] = [];
  let lastFailure: ModelCallFailure | null = null;

  for (let index = 0; index < staticModels.length; index += 1) {
    const attempt = index + 1;
    const reservedModel = quotaRouting
      ? await reserveGeminiModelQuota(input.env, {
        excludedModels,
        estimatedTokens: estimateGeminiTokens(input.input, input.answerContext, input.env),
      })
      : null;
    const model = reservedModel?.model ?? (quotaRouting ? null : staticModels[index]);
    if (!model) {
      const fallbackReason = "gemini_quota_exhausted";
      return lastFailure ?? {
        ok: false,
        reason: "llm_http_error",
        status: 429,
        attempts: providerAttempts.length,
        fallbackReason,
        providerAttempts,
      };
    }
    excludedModels.push(model);
    try {
      const response = await input.fetchImpl(
        `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(
            createGeminiGenerateContentRequest(
              input.env,
              input.input,
              input.answerContext,
              input.retryReason,
            ),
          ),
        },
      );

      if (!response.ok) {
        const fallbackReason = `gemini_http_${response.status}`;
        providerAttempts.push({
          provider: "gemini",
          model,
          ok: false,
          reason: "llm_http_error",
          status: response.status,
          fallback_reason: fallbackReason,
        });
        lastFailure = {
          ok: false,
          reason: "llm_http_error",
          status: response.status,
          attempts: attempt,
          fallbackReason,
          providerAttempts: [...providerAttempts],
        };
        if (isTransientHttpStatus(response.status) && attempt < staticModels.length) {
          continue;
        }
        return lastFailure;
      }

      const payload = await readJsonPayload(response);
      if (!payload) {
        const fallbackReason = "gemini_empty_content";
        providerAttempts.push({
          provider: "gemini",
          model,
          ok: false,
          reason: "empty_content",
          fallback_reason: fallbackReason,
        });
        lastFailure = {
          ok: false,
          reason: "empty_content",
          attempts: attempt,
          fallbackReason,
          providerAttempts: [...providerAttempts],
        };
        if (attempt < staticModels.length) {
          continue;
        }
        return lastFailure;
      }

      const content = extractGeminiContent(payload);
      if (!content) {
        const fallbackReason = "gemini_empty_content";
        providerAttempts.push({
          provider: "gemini",
          model,
          ok: false,
          reason: "empty_content",
          fallback_reason: fallbackReason,
        });
        lastFailure = {
          ok: false,
          reason: "empty_content",
          attempts: attempt,
          fallbackReason,
          providerAttempts: [...providerAttempts],
        };
        if (attempt < staticModels.length) {
          continue;
        }
        return lastFailure;
      }

      providerAttempts.push({ provider: "gemini", model, ok: true });
      return {
        ok: true,
        content,
        provider: "gemini",
        modelName: model,
        attempts: attempt,
        ...(lastFailure?.fallbackReason ? { fallbackReason: lastFailure.fallbackReason } : {}),
        providerAttempts,
      };
    } catch {
      const fallbackReason = "gemini_fetch_error";
      providerAttempts.push({
        provider: "gemini",
        model,
        ok: false,
        reason: "llm_fetch_error",
        fallback_reason: fallbackReason,
      });
      lastFailure = {
        ok: false,
        reason: "llm_fetch_error",
        attempts: attempt,
        fallbackReason,
        providerAttempts: [...providerAttempts],
      };
      if (attempt < staticModels.length) {
        continue;
      }
      return lastFailure;
    }
  }

  return lastFailure ?? {
    ok: false,
    reason: "llm_fetch_error",
    attempts: staticModels.length,
    providerAttempts,
  };
}
async function callOpenRouterProvider(input: {
  env: Env;
  fetchImpl: AssistantLlmFetch;
  input: GroundedAnswerInput;
  answerContext: AnswerContext;
  retryReason: AssistantAnswerFailureReason | null;
}): Promise<ModelCallSuccess | ModelCallFailure> {
  const apiKey = input.env.ASSISTANT_LLM_API_KEY ?? input.env.OPENROUTER_API_KEY;
  const model = input.env.ASSISTANT_OPENROUTER_MODEL ?? input.env.ASSISTANT_CHAT_MODEL ?? DEFAULT_OPENROUTER_MODEL;
  if (!apiKey) {
    return {
      ok: false,
      reason: "missing_config",
      attempts: 0,
      providerAttempts: [],
    };
  }

  const openRouterReserved = input.env.ASSISTANT_PROVIDER_QUOTA_ROUTING_ENABLED === "true"
    ? await reserveOpenRouterQuota(input.env)
    : true;
  if (!openRouterReserved) {
    return {
      ok: false,
      reason: "llm_http_error",
      status: 429,
      attempts: 0,
      fallbackReason: "openrouter_quota_unavailable",
      providerAttempts: [],
    };
  }

  const baseUrl = (input.env.ASSISTANT_LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL).replace(/\/$/, "");

  try {
    const response = await input.fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        createChatCompletionRequest(
          input.env,
          model,
          input.input,
          input.answerContext,
          input.retryReason,
        ),
      ),
    });

    if (!response.ok) {
      const fallbackReason = `openrouter_http_${response.status}`;
      return {
        ok: false,
        reason: "llm_http_error",
        status: response.status,
        attempts: 1,
        fallbackReason,
        providerAttempts: [
          {
            provider: "openrouter",
            model,
            ok: false,
            reason: "llm_http_error",
            status: response.status,
            fallback_reason: fallbackReason,
          },
        ],
      };
    }

    const payload = await readJsonPayload(response);
    if (!payload) {
      return {
        ok: false,
        reason: "empty_content",
        attempts: 1,
        fallbackReason: "openrouter_empty_content",
        providerAttempts: [
          {
            provider: "openrouter",
            model,
            ok: false,
            reason: "empty_content",
            fallback_reason: "openrouter_empty_content",
          },
        ],
      };
    }

    const content = extractMessageContent(payload);
    if (!content) {
      return {
        ok: false,
        reason: "empty_content",
        attempts: 1,
        fallbackReason: "openrouter_empty_content",
        providerAttempts: [
          {
            provider: "openrouter",
            model,
            ok: false,
            reason: "empty_content",
            fallback_reason: "openrouter_empty_content",
          },
        ],
      };
    }

    return {
      ok: true,
      content,
      provider: "openrouter",
      modelName: model,
      attempts: 1,
      providerAttempts: [{ provider: "openrouter", model, ok: true }],
    };
  } catch {
    return {
      ok: false,
      reason: "llm_fetch_error",
      attempts: 1,
      fallbackReason: "openrouter_fetch_error",
      providerAttempts: [
        {
          provider: "openrouter",
          model,
          ok: false,
          reason: "llm_fetch_error",
          fallback_reason: "openrouter_fetch_error",
        },
      ],
    };
  }
}
function estimateGeminiTokens(
  input: GroundedAnswerInput,
  answerContext: AnswerContext,
  env: Env,
): number {
  const requestChars = JSON.stringify({
    question: input.query,
    follow_up: input.followUp,
    chunks: answerContext.modelChunks,
  }).length;
  return Math.ceil(requestChars / 4) + parseMaxOutputTokens(env);
}
function createGeminiGenerateContentRequest(
  env: Env,
  input: GroundedAnswerInput,
  answerContext: AnswerContext,
  retryReason: AssistantAnswerFailureReason | null = null,
): Record<string, unknown> {
  return {
    systemInstruction: {
      parts: [
        {
          text: createSystemPrompt(retryReason, answerContext.compact),
        },
      ],
    },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: JSON.stringify({
              question: input.query,
              ...(input.followUp
                ? {
                  follow_up: {
                    previous_user_message: input.followUp.previous_user_message,
                    previous_assistant_answer: input.followUp.previous_assistant_answer,
                    previous_cited_chunk_ids: input.followUp.previous_cited_chunk_ids,
                  },
                }
                : {}),
              chunks: answerContext.modelChunks,
            }),
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: parseMaxOutputTokens(env),
      responseMimeType: "application/json",
      responseSchema: answerResponseSchema(),
    },
  };
}

function answerResponseSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["status", "answer", "confidence", "cited_chunk_ids"],
    properties: {
      status: { type: "string", enum: ["ANSWERED", "NOT_FOUND_IN_BATCH"] },
      answer: { type: "string" },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      cited_chunk_ids: {
        type: "array",
        items: {
          type: "string",
        },
      },
    },
  };
}

function extractGeminiContent(payload: Record<string, unknown> | null): string | null {
  const candidates = payload?.candidates;
  if (!Array.isArray(candidates)) {
    return null;
  }
  const content = asRecord(asRecord(candidates[0])?.content);
  const parts = content?.parts;
  if (!Array.isArray(parts)) {
    return null;
  }
  return parts.map((part) => asString(asRecord(part)?.text) ?? "").join("").trim() || null;
}

function isProviderFallbackFailure(failure: ModelCallFailure): boolean {
  if (failure.reason === "llm_fetch_error" || failure.reason === "empty_content") {
    return true;
  }
  return failure.reason === "llm_http_error" && isTransientHttpStatus(failure.status);
}

function isTransientHttpStatus(status: number | undefined): boolean {
  return status === 408 || status === 409 || status === 429 || (typeof status === "number" && status >= 500);
}

function parseGeminiModelAttempts(env: Env): string[] {
  const ladder = env.ASSISTANT_GEMINI_MODEL_LADDER
    ?.split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  if (ladder?.length) {
    return Array.from(new Set(ladder)).slice(0, MAX_GEMINI_MODEL_ATTEMPTS);
  }

  const model = env.ASSISTANT_GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
  return Array.from({ length: parseGeminiMaxAttempts(env) }, () => model);
}

function parseGeminiMaxAttempts(env: Env): number {
  const parsed = Number.parseInt(env.ASSISTANT_GEMINI_MAX_ATTEMPTS ?? "", 10);
  if (!Number.isInteger(parsed)) {
    return DEFAULT_GEMINI_MAX_ATTEMPTS;
  }
  return Math.min(3, Math.max(1, parsed));
}
function parseModelAnswerStatus(value: unknown): ModelAnswerStatus {
  return value === "NOT_FOUND_IN_BATCH" ? "NOT_FOUND_IN_BATCH" : "ANSWERED";
}
export function validateModelAnswer(
  modelAnswer: ModelAnswer | null,
  chunks: RetrievedChunk[],
  resolveCitationId: (id: string) => string = (id) => id,
): ValidatedGroundedAnswer | null {
  if (!modelAnswer || typeof modelAnswer.answer !== "string") {
    return null;
  }

  const answer = modelAnswer.answer.trim();
  if (!answer) {
    return null;
  }

  const chunksById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
  const citedChunkIdCandidates = Array.isArray(modelAnswer.cited_chunk_ids)
    ? modelAnswer.cited_chunk_ids
    : [];
  const validatedCitations: Citation[] = [];
  const citedChunkIds: string[] = [];
  const seen = new Set<string>();

  for (const citedChunkId of citedChunkIdCandidates) {
    const rawChunkId = asString(citedChunkId);
    const chunkId = rawChunkId ? resolveCitationId(rawChunkId) : null;
    if (!chunkId || seen.has(chunkId)) {
      continue;
    }

    const chunk = chunksById.get(chunkId);
    if (!chunk) {
      continue;
    }

    seen.add(chunkId);
    citedChunkIds.push(chunkId);
    validatedCitations.push({
      title: chunk.title,
      url: chunk.url,
      snippet: createSnippet(chunk.text),
    });
  }

  if (!validatedCitations.length) {
    return null;
  }

  return {
    answer,
    citations: validatedCitations,
    cited_chunk_ids: citedChunkIds,
    confidence: parseConfidence(modelAnswer.confidence),
  };
}

function createChatCompletionRequest(
  env: Env,
  model: string,
  input: GroundedAnswerInput,
  answerContext: AnswerContext,
  retryReason: AssistantAnswerFailureReason | null = null,
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "system",
        content: createSystemPrompt(retryReason, answerContext.compact),
      },
      {
        role: "user",
        content: JSON.stringify({
          question: input.query,
          ...(input.followUp
            ? {
              follow_up: {
                previous_user_message: input.followUp.previous_user_message,
                previous_assistant_answer: input.followUp.previous_assistant_answer,
                previous_cited_chunk_ids: input.followUp.previous_cited_chunk_ids,
              },
            }
            : {}),
          chunks: answerContext.modelChunks,
        }),
      },
    ],
    temperature: 0,
    max_tokens: parseMaxOutputTokens(env),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "grounded_assistant_answer",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["status", "answer", "confidence", "cited_chunk_ids"],
          properties: {
            status: { type: "string", enum: ["ANSWERED", "NOT_FOUND_IN_BATCH"] },
            answer: { type: "string" },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
            cited_chunk_ids: {
              type: "array",
              items: {
                type: "string",
              },
            },
          },
        },
      },
    },
  };

  if (env.ASSISTANT_LLM_PROVIDER_SORT) {
    request.provider = { sort: env.ASSISTANT_LLM_PROVIDER_SORT };
  }

  return request;
}

function createSystemPrompt(retryReason: AssistantAnswerFailureReason | null, compactContext = false): string {
  const lines = [
    "You are Ask Zico, a citation-bound assistant for the configured knowledge library.",
    "Answer only from the provided chunks. If the chunks do not explicitly support the answer, return status NOT_FOUND_IN_BATCH, an empty answer, low confidence, and no cited_chunk_ids.",
    "For religious and liturgical questions about rites, fast dates, hymn timing, sacramental details, or church practice, refusal is better than speculation unless the provided chunks explicitly answer the question.",
    "Preserve Coptic terms, hymn titles, and transliterated text exactly as they appear in the source.",
    "Voice and tone contract: answer in Egyptian Arabic, friendly and respectful, concise and conversational, not overly formal MSA unless quoting sources, and do not invent slang.",
    "The answer field may use a constrained Markdown subset: paragraphs, bullet lists, and bold text only.",
    "Do not include raw HTML, tables, headings, images, or source links in the answer field.",
    "When retrieved chunks conflict or cover nearby but different events, prefer chunks whose title or section best matches the user's requested topic.",
    "Do not confuse remedies, protections, or safeguards with the thing the user asks to identify. For questions like 'what are X?', answer what X are first, then mention remedies only if directly asked or needed.",
    "If follow_up is provided, use the previous user message and previous assistant answer only to understand what the current short question refers to. The final answer must still be supported by the provided chunks, and cited_chunk_ids must still come from the provided chunks.",
    "Return cited_chunk_ids only. Do not return citation objects, titles, URLs, snippets, or prose outside the JSON object.",
    compactContext
      ? "The chunks use compact evidence IDs. Every cited_chunk_ids value must return evidence IDs like C1, C2, or C3 from the provided chunks and must directly support the answer."
      : "Every cited_chunk_ids value must exactly match a chunk_id from the provided chunks and must directly support the answer.",
    "Return status ANSWERED only when the provided chunks directly support the answer.",
    "Return only JSON matching the requested schema.",
  ];

  if (retryReason === "invalid_json") {
    lines.push(
      "Previous output was not valid parseable JSON. Repair the response by returning exactly one JSON object matching the schema.",
    );
  }

  if (retryReason === "incomplete_answer") {
    lines.push(
      "Previous answer was incomplete or cut off. Return a complete concise answer with a finished final sentence.",
    );
  }

  return lines.join("\n");
}

async function readJsonPayload(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(await response.json());
  } catch {
    return null;
  }
}

function extractMessageContent(payload: Record<string, unknown> | null): string | null {
  const choices = payload?.choices;
  if (!Array.isArray(choices)) {
    return null;
  }

  const message = asRecord(asRecord(choices[0])?.message);
  return asString(message?.content);
}

function parseModelAnswer(content: string): ModelAnswer | null {
  const trimmed = content.trim();
  const json = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;

  try {
    return asRecord(JSON.parse(json)) as ModelAnswer | null;
  } catch {
    return null;
  }
}

function parseConfidence(value: unknown): Confidence {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : DEFAULT_CONFIDENCE;
}

function isIncompleteAnswer(answer: string): boolean {
  const trimmed = answer
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[*_`#>]+$/g, "")
    .trim();
  if (!trimmed) {
    return true;
  }

  if (INCOMPLETE_ANSWER_TRAILING_PATTERN.test(trimmed)) {
    return true;
  }

  const words = trimmed.match(/[\p{L}\p{M}]+/gu);
  const lastWord = words?.at(-1)?.toLowerCase();
  return lastWord ? INCOMPLETE_ANSWER_ENDINGS.has(lastWord) : false;
}

function parseMaxOutputTokens(env: Env): number {
  const parsed = Number.parseInt(env.ASSISTANT_CONTEXT_MAX_OUTPUT_TOKENS ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }
  return Math.min(2000, Math.max(100, parsed));
}

function failure(
  reason: AssistantAnswerFailureReason,
  status?: number,
  attempts?: number,
  batchAttempts?: number,
  providerFallbackReason?: string,
  providerAttempts?: ProviderAttempt[],
): GroundedAnswerResult {
  const debug = {
    mode: "handoff" as const,
    reason,
    ...(status === undefined ? {} : { status }),
    ...(attempts === undefined || attempts <= 1 ? {} : { attempts }),
    ...(batchAttempts === undefined ? {} : { batch_attempts: batchAttempts }),
    ...(providerFallbackReason ? { provider_fallback_reason: providerFallbackReason } : {}),
    ...(providerAttempts?.length ? { provider_attempts: providerAttempts } : {}),
  };

  return {
    ok: false,
    reason,
    ...(status === undefined ? {} : { status }),
    debug,
  };
}

function createSnippet(text: string): string {
  return text.trim().slice(0, 280);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
