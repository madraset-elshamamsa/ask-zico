import type { AssistantLlmFetch, DetectedLanguage, Env } from "./types";
import type { AssistantProviderAttempt } from "./types";
import { estimateModelCostUsd } from "./economics";
export type TranslationResult =
  | { ok: true; query: string; provider: "gemini" | "openrouter"; latencyMs: number; providerAttempts: AssistantProviderAttempt[]; modelCalls: number; estimatedModelCostUsd: number }
  | { ok: false; status: "failed" | "missing_config"; provider?: "gemini" | "openrouter"; latencyMs: number; providerAttempts: AssistantProviderAttempt[]; modelCalls: number; estimatedModelCostUsd: number };

const ARABIC_SCRIPT = /\p{Script=Arabic}/u;
const LATIN_SCRIPT = /\p{Script=Latin}/u;
const COPTIC_SCRIPT = /\p{Script=Coptic}/u;
const LETTER = /\p{Letter}/u;
const QUOTED_SPANS = /"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|«[^»]*»/gu;
const ENGLISH_FUNCTION_WORDS = new Set([
  "a", "about", "an", "and", "are", "can", "could", "did", "do", "does",
  "for", "from", "how", "in", "is", "mean", "of", "on", "please", "tell",
  "the", "to", "what", "when", "where", "which", "who", "why", "with",
]);
const NON_ENGLISH_LATIN_MARKERS = new Set([
  // French
  "allez", "bonjour", "explique", "pourquoi", "quel", "quelle", "signifie", "vous",
  // Spanish
  "dime", "donde", "significa", "significado",
  // Italian
  "dimmi", "perche", "significato", "spiega", "spiegami",
  // German
  "bedeutet", "erklaere", "taufe", "warum",
  // Portuguese
  "batismo", "diga", "porque", "voce",
]);
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash-lite";

export function detectMessageLanguage(message: string): DetectedLanguage {
  let hasArabic = false;
  let hasLatin = false;
  let hasCoptic = false;
  for (const character of message) {
    if (ARABIC_SCRIPT.test(character)) hasArabic = true;
    else if (LATIN_SCRIPT.test(character)) hasLatin = true;
    else if (COPTIC_SCRIPT.test(character)) hasCoptic = true;
    else if (LETTER.test(character)) return "unsupported";
  }
  if (hasArabic) return "ar";
  if (hasLatin) return isLikelyEnglishLatinMessage(message) ? "en" : "unsupported";
  return hasCoptic ? "unsupported" : "unsupported";
}
export function hasSubstantiveEnglish(message: string): boolean {
  const unquoted = message.replace(QUOTED_SPANS, " ");
  const latinWords = unquoted.match(/\p{Script=Latin}[\p{Script=Latin}\p{Mark}'’-]*/gu) ?? [];
  if (latinWords.length < 2) return false;
  const functionWords = latinWords.filter((word) => ENGLISH_FUNCTION_WORDS.has(word.toLocaleLowerCase("en"))).length;
  if (functionWords >= 2) return true;
  const { arabic, latin } = scriptLetterCounts(unquoted);
  return latin >= 16 && latin > arabic * 1.25;
}

export function isMeaningfullyArabic(value: string): boolean {
  const { arabic, latin, other } = scriptWordCounts(value);
  if (arabic === 1 && latin === 0 && other === 0) {
    const arabicLetters = [...value].filter((character) => ARABIC_SCRIPT.test(character)).length;
    return arabicLetters >= 3;
  }
  const counted = arabic + latin + other;
  return arabic >= 2 && counted > 0 && arabic / counted >= 2 / 3;
}

function isLikelyEnglishLatinMessage(value: string): boolean {
  const words = (value.match(/\p{Script=Latin}[\p{Script=Latin}\p{Mark}'’-]*/gu) ?? [])
    .map((word) => word.toLocaleLowerCase("en"));
  if (!words.length) return false;
  if (words.some((word) => NON_ENGLISH_LATIN_MARKERS.has(word))) return false;
  if (words.some((word) => /[^a-z'’-]/u.test(word))) return false;
  return true;
}

function scriptWordCounts(value: string): { arabic: number; latin: number; other: number } {
  let arabic = 0;
  let latin = 0;
  let other = 0;
  for (const word of value.match(/[\p{Letter}\p{Mark}'’-]+/gu) ?? []) {
    if (ARABIC_SCRIPT.test(word)) arabic += 1;
    else if (LATIN_SCRIPT.test(word)) latin += 1;
    else if (!COPTIC_SCRIPT.test(word)) other += 1;
  }
  return { arabic, latin, other };
}

export function isMeaningfullyEnglish(value: string): boolean {
  const { arabic, latin, other } = scriptLetterCounts(value);
  const counted = arabic + latin + other;
  return latin >= 3 && counted > 0 && latin / counted >= 0.35;
}

function scriptLetterCounts(value: string): { arabic: number; latin: number; other: number } {
  let arabic = 0;
  let latin = 0;
  let other = 0;
  for (const character of value) {
    if (ARABIC_SCRIPT.test(character)) arabic += 1;
    else if (LATIN_SCRIPT.test(character)) latin += 1;
    else if (LETTER.test(character) && !COPTIC_SCRIPT.test(character)) other += 1;
  }
  return { arabic, latin, other };
}

export async function translateEnglishRetrievalQuery(query: string, env: Env): Promise<TranslationResult> {
  const startedAt = Date.now();
  const fetchImpl: AssistantLlmFetch = env.ASSISTANT_LLM_FETCH ?? fetch;
  const providerAttempts: AssistantProviderAttempt[] = [];
  const prompt = "Translate this English search query into concise Arabic for retrieving an Arabic corpus. Preserve Coptic terms, hymn titles, proper names, and quoted terms exactly. Return only the Arabic query.\n\n" + query;

  if (!env.ASSISTANT_GEMINI_API_KEY) {
    return { ok: false, status: "missing_config", latencyMs: Date.now() - startedAt, providerAttempts, modelCalls: 0, estimatedModelCostUsd: 0 };
  }

  const geminiModel = env.ASSISTANT_GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
  try {
      const response = await fetchImpl(`${env.ASSISTANT_GEMINI_BASE_URL ?? GEMINI_BASE_URL}/models/${geminiModel}:generateContent?key=${encodeURIComponent(env.ASSISTANT_GEMINI_API_KEY)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } }),
      });
      if (response.ok) {
        const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const translated = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
        if (translated && isMeaningfullyArabic(translated)) {
          providerAttempts.push({ provider: "gemini", model: geminiModel, ok: true, operation: "translation" });
          return { ok: true, query: translated, provider: "gemini", latencyMs: Date.now() - startedAt, providerAttempts, modelCalls: 1, estimatedModelCostUsd: estimateModelCostUsd(env) };
        }
      }
      providerAttempts.push({
        provider: "gemini", model: geminiModel, ok: false, operation: "translation",
        reason: response.ok ? "empty_content" : "llm_http_error",
        ...(response.ok ? {} : { status: response.status }),
      });
  } catch {
    providerAttempts.push({ provider: "gemini", model: geminiModel, ok: false, operation: "translation", reason: "llm_fetch_error" });
  }

  if (env.ASSISTANT_LLM_API_KEY || env.OPENROUTER_API_KEY) {
    const openRouterModel = env.ASSISTANT_CHAT_MODEL ?? env.ASSISTANT_OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL;
    try {
      const response = await fetchImpl(`${env.ASSISTANT_LLM_BASE_URL ?? OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.ASSISTANT_LLM_API_KEY ?? env.OPENROUTER_API_KEY}` },
        body: JSON.stringify({ model: openRouterModel, messages: [{ role: "user", content: prompt }], temperature: 0 }),
      });
      if (response.ok) {
        const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        const translated = payload.choices?.[0]?.message?.content?.trim();
        if (translated && isMeaningfullyArabic(translated)) {
          providerAttempts.push({ provider: "openrouter", model: openRouterModel, ok: true, operation: "translation" });
          return { ok: true, query: translated, provider: "openrouter", latencyMs: Date.now() - startedAt, providerAttempts, modelCalls: providerAttempts.length, estimatedModelCostUsd: providerAttempts.length * estimateModelCostUsd(env) };
        }
      }
      providerAttempts.push({
        provider: "openrouter", model: openRouterModel, ok: false, operation: "translation",
        reason: response.ok ? "empty_content" : "llm_http_error",
        ...(response.ok ? {} : { status: response.status }),
      });
    } catch {
      providerAttempts.push({ provider: "openrouter", model: openRouterModel, ok: false, operation: "translation", reason: "llm_fetch_error" });
    }
  }

  return {
    ok: false,
    status: "failed",
    provider: env.ASSISTANT_LLM_API_KEY || env.OPENROUTER_API_KEY ? "openrouter" : "gemini",
    latencyMs: Date.now() - startedAt,
    providerAttempts,
    modelCalls: providerAttempts.length,
    estimatedModelCostUsd: providerAttempts.length * estimateModelCostUsd(env),
  };
}
