import { normalizeArabicForSearch } from "./arabic";
import type { Env, RetrievedChunk } from "./types";

const DEFAULT_CONTEXT_TOP_K = 3;
const DEFAULT_EXCERPT_CHARS = 1200;
const MIN_CONTEXT_TOP_K = 1;
const MAX_CONTEXT_TOP_K = 8;
const MIN_EXCERPT_CHARS = 200;
const DEFAULT_MAX_EXCERPT_CHARS = 0;

export type AnswerContextOptions = {
  topK: number;
  excerptChars: number;
};

export type FullModelChunk = {
  chunk_id: string;
  title: string;
  url: string;
  section?: string;
  content_type?: string;
  text: string;
};

export type CompactModelChunk = {
  id: string;
  title: string;
  section?: string;
  content_type?: string;
  excerpt: string;
};

export type AnswerContextDebug = {
  compact_context: true;
  context_chunks: number;
  context_excerpt_chars: number;
  input_chunk_chars: number;
  model_context_chars: number;
};

export type AnswerContext = {
  compact: boolean;
  modelChunks: Array<FullModelChunk | CompactModelChunk>;
  resolveCitationId: (id: string) => string;
  debug?: AnswerContextDebug;
};

export function compactContextEnabled(env: Env): boolean {
  return env.ASSISTANT_COMPACT_CONTEXT_ENABLED === "true";
}

export function parseAnswerContextOptions(env: Env): AnswerContextOptions {
  return {
    topK: parseBoundedInt(env.ASSISTANT_CONTEXT_TOP_K, DEFAULT_CONTEXT_TOP_K, MIN_CONTEXT_TOP_K, MAX_CONTEXT_TOP_K),
    excerptChars: parseBoundedInt(
      env.ASSISTANT_CONTEXT_EXCERPT_CHARS,
      DEFAULT_EXCERPT_CHARS,
      MIN_EXCERPT_CHARS,
      parseOptionalMaxExcerptChars(env.ASSISTANT_CONTEXT_MAX_EXCERPT_CHARS),
    ),
  };
}

export function buildAnswerContext(input: {
  env: Env;
  query: string;
  chunks: RetrievedChunk[];
  selectedChunks?: RetrievedChunk[];
}): AnswerContext {
  const sourceChunks = input.selectedChunks ?? input.chunks;

  if (!compactContextEnabled(input.env)) {
    return {
      compact: false,
      modelChunks: sourceChunks.map((chunk) => ({
        chunk_id: chunk.chunk_id,
        title: chunk.title,
        url: chunk.url,
        section: chunk.section,
        content_type: chunk.content_type,
        text: chunk.text,
      })),
      resolveCitationId: (id) => id,
    };
  }

  const options = parseAnswerContextOptions(input.env);
  const selectedChunks = sourceChunks.slice(0, options.topK);
  const citationIdMap = new Map<string, string>();
  const modelChunks = selectedChunks.map((chunk, index) => {
    const id = `C${index + 1}`;
    citationIdMap.set(id, chunk.chunk_id);
    return {
      id,
      title: chunk.title,
      section: chunk.section,
      content_type: chunk.content_type,
      excerpt: extractFocusedExcerpt(chunk.text, input.query, options.excerptChars),
    };
  });

  return {
    compact: true,
    modelChunks,
    resolveCitationId: (id) => citationIdMap.get(id) ?? id,
    debug: {
      compact_context: true,
      context_chunks: modelChunks.length,
      context_excerpt_chars: options.excerptChars,
      input_chunk_chars: input.chunks.reduce((total, chunk) => total + chunk.text.length, 0),
      model_context_chars: modelChunks.reduce((total, chunk) => total + chunk.excerpt.length, 0),
    },
  };
}

function extractFocusedExcerpt(text: string, query: string, maxChars: number): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (cleaned.length <= maxChars) {
    return cleaned;
  }

  const normalizedText = normalizeArabicForSearch(cleaned).toLowerCase();
  const queryTokens = tokenize(normalizeArabicForSearch(query).toLowerCase());
  const matchIndex = firstTokenIndex(normalizedText, queryTokens);
  if (matchIndex === -1) {
    return cleaned.slice(0, maxChars).trim();
  }

  const start = Math.max(0, matchIndex - Math.floor(maxChars / 3));
  const end = Math.min(cleaned.length, start + maxChars);
  return cleaned.slice(start, end).trim();
}

function tokenize(value: string): string[] {
  return [...new Set(value.split(/\s+/).filter((token) => token.length > 2))];
}

function firstTokenIndex(text: string, tokens: string[]): number {
  const indexes = tokens
    .map((token) => text.indexOf(token))
    .filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : -1;
}

function parseOptionalMaxExcerptChars(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_EXCERPT_CHARS;
  }
  return Math.max(MIN_EXCERPT_CHARS, parsed);
}

function parseBoundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const minBounded = Math.max(min, parsed);
  return max > 0 ? Math.min(max, minBounded) : minBounded;
}
