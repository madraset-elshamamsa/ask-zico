import { describe, expect, test } from "vitest";
import { parseAssistantMessageRequest } from "../src/request";

describe("parseAssistantMessageRequest", () => {
  test("parses one-turn follow-up context when provided", () => {
    const request = parseAssistantMessageRequest({
      conversation_id: "conversation-1",
      message: "طب ينفع مثال؟",
      follow_up: {
        parent_message_id: "message-1",
        previous_user_message: "يعني إيه الطريق الداخلي؟",
        previous_assistant_answer: "الطريق الداخلي هو بداية حل المشكلة من القلب.",
        previous_cited_chunk_ids: ["wa3zat:ElTariqElDa5ely:0", "  "],
      },
    });

    expect(request?.follow_up).toEqual({
      parent_message_id: "message-1",
      previous_user_message: "يعني إيه الطريق الداخلي؟",
      previous_assistant_answer: "الطريق الداخلي هو بداية حل المشكلة من القلب.",
      previous_cited_chunk_ids: ["wa3zat:ElTariqElDa5ely:0"],
    });
  });

  test("rejects oversized direct messages and follow-up context", () => {
    expect(parseAssistantMessageRequest({ message: "x".repeat(801) })).toBeNull();
    expect(parseAssistantMessageRequest({
      message: "short",
      follow_up: {
        parent_message_id: "message-1",
        previous_user_message: "u".repeat(1201),
        previous_assistant_answer: "answer",
        previous_cited_chunk_ids: [],
      },
    })?.follow_up).toBeUndefined();
    expect(parseAssistantMessageRequest({
      message: "short",
      follow_up: {
        parent_message_id: "message-1",
        previous_user_message: "question",
        previous_assistant_answer: "a".repeat(1201),
        previous_cited_chunk_ids: [],
      },
    })?.follow_up).toBeUndefined();
  });

  test("accepts sanitized proxy metadata for pre-normalized retrieval", () => {
    const request = parseAssistantMessageRequest({
      message: "short",
      normalized_query: "normalized query",
      retrieval_query: "retrieval query",
    });

    expect(request?.normalized_query).toBe("normalized query");
    expect(request?.retrieval_query).toBe("retrieval query");
  });

  test("accepts only supported UI locales", () => {
    expect(parseAssistantMessageRequest({ message: "سؤال", locale: "ar" })?.locale).toBe("ar");
    expect(parseAssistantMessageRequest({ message: "Question", locale: "en" })?.locale).toBe("en");
    expect(parseAssistantMessageRequest({ message: "Question", locale: "fr" })?.locale).toBeUndefined();
    expect(parseAssistantMessageRequest({ message: "Question", locale: " EN " })?.locale).toBeUndefined();
  });

});
