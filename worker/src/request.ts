import type { AssistantFollowUpContext, AssistantMessageRequest } from "./types";

const MAX_MESSAGE_CHARS = 800;
const MAX_FOLLOW_UP_CHARS = 1200;

export function parseAssistantMessageRequest(value: unknown): AssistantMessageRequest | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<AssistantMessageRequest>;
  const message = normalizeString(candidate.message, MAX_MESSAGE_CHARS);
  if (!message) {
    return null;
  }

  return {
    session_id:
      typeof candidate.session_id === "string" && candidate.session_id.trim()
        ? candidate.session_id.trim()
        : undefined,
    conversation_id:
      typeof candidate.conversation_id === "string" && candidate.conversation_id.trim()
        ? candidate.conversation_id.trim()
        : undefined,
    assistant_device_id:
      typeof candidate.assistant_device_id === "string" && candidate.assistant_device_id.trim()
        ? candidate.assistant_device_id.trim()
        : undefined,
    user_id:
      typeof candidate.user_id === "string" && candidate.user_id.trim()
        ? candidate.user_id.trim()
        : undefined,
    actor_id: normalizeString(candidate.actor_id),
    network_id: normalizeString(candidate.network_id),
    actor_type:
      candidate.actor_type === "anonymous" || candidate.actor_type === "authenticated"
        ? candidate.actor_type
        : undefined,
    challenge_verified: candidate.challenge_verified === true,
    message,
    normalized_query: normalizeString(candidate.normalized_query, MAX_MESSAGE_CHARS * 2),
    retrieval_query: normalizeString(candidate.retrieval_query, MAX_MESSAGE_CHARS * 2),
    page_context:
      candidate.page_context && typeof candidate.page_context === "object"
        ? {
          url:
            typeof candidate.page_context.url === "string"
              ? candidate.page_context.url
              : undefined,
          title:
            typeof candidate.page_context.title === "string"
              ? candidate.page_context.title
              : undefined,
        }
        : undefined,
    locale: candidate.locale === "ar" || candidate.locale === "en" ? candidate.locale : undefined,
    retrieval_only: candidate.retrieval_only === true,
    debug: candidate.debug === true,
    follow_up: parseFollowUpContext(candidate.follow_up),
  };
}

function parseFollowUpContext(value: unknown): AssistantFollowUpContext | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<AssistantFollowUpContext>;
  const parentMessageId = normalizeString(candidate.parent_message_id);
  const previousUserMessage = normalizeString(candidate.previous_user_message, MAX_FOLLOW_UP_CHARS);
  const previousAssistantAnswer = normalizeString(candidate.previous_assistant_answer, MAX_FOLLOW_UP_CHARS);
  const previousCitedChunkIds = Array.isArray(candidate.previous_cited_chunk_ids)
    ? uniqueStrings(candidate.previous_cited_chunk_ids.map((value) => normalizeString(value)))
    : [];

  if (!parentMessageId || !previousUserMessage || !previousAssistantAnswer) {
    return undefined;
  }

  return {
    parent_message_id: parentMessageId,
    previous_user_message: previousUserMessage,
    previous_assistant_answer: previousAssistantAnswer,
    previous_cited_chunk_ids: previousCitedChunkIds.slice(0, 4),
  };
}

function normalizeString(value: unknown, maxChars = 120): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxChars) {
    return undefined;
  }
  return normalized;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}
