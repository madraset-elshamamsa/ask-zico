import { mirrorAssistantFeedbackRating } from "./observability";
import type { AssistantFeedbackRequest, Env } from "./types";

const VALID_RATINGS = new Set(["up", "down"]);
const VALID_CONFIDENCE = new Set(["retrieval_only", "low", "medium", "high"]);

export function parseAssistantFeedbackRequest(
  value: unknown,
): AssistantFeedbackRequest | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<AssistantFeedbackRequest>;
  const sessionId = normalizeRequiredString(candidate.session_id);
  const messageId = normalizeRequiredString(candidate.message_id);
  const rating = normalizeRequiredString(candidate.rating);
  const createdAt = normalizeRequiredString(candidate.created_at);

  if (!sessionId || !messageId || !rating || !createdAt) {
    return null;
  }

  if (!VALID_RATINGS.has(rating) || Number.isNaN(Date.parse(createdAt))) {
    return null;
  }

  const confidence =
    typeof candidate.confidence === "string" && VALID_CONFIDENCE.has(candidate.confidence)
      ? candidate.confidence
      : undefined;

  return {
    session_id: sessionId,
    message_id: messageId,
    conversation_id: normalizeOptionalString(candidate.conversation_id),
    rating: rating as AssistantFeedbackRequest["rating"],
    confidence,
    doc_ids: normalizeStringArray(candidate.doc_ids),
    chunk_ids: normalizeStringArray(candidate.chunk_ids),
    citation_urls: normalizeStringArray(candidate.citation_urls),
    created_at: new Date(createdAt).toISOString(),
  };
}

export async function storeAssistantFeedback(
  env: Env,
  feedback: AssistantFeedbackRequest,
): Promise<"ok" | "missing_binding" | "write_failed"> {
  if (!env.ASSISTANT_FEEDBACK_DB) {
    return "missing_binding";
  }

  try {
    const result = await env.ASSISTANT_FEEDBACK_DB.prepare(
      `INSERT INTO assistant_feedback (
        session_id,
        message_id,
        conversation_id,
        rating,
        confidence,
        doc_ids_json,
        chunk_ids_json,
        citation_urls_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        feedback.session_id,
        feedback.message_id,
        feedback.conversation_id ?? null,
        feedback.rating,
        feedback.confidence ?? null,
        JSON.stringify(feedback.doc_ids ?? []),
        JSON.stringify(feedback.chunk_ids ?? []),
        JSON.stringify(feedback.citation_urls ?? []),
        feedback.created_at,
      )
      .run();

    if (result.success === false) {
      return "write_failed";
    }

    await mirrorAssistantFeedbackRating(env, {
      messageId: feedback.message_id,
      rating: feedback.rating,
      createdAt: feedback.created_at,
    });

    return "ok";
  } catch {
    return "write_failed";
  }
}

function normalizeRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());

  return normalized.length > 0 ? normalized : undefined;
}
