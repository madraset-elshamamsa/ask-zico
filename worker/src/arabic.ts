import { applySearchAliases } from "./aliases";

const ARABIC_DIACRITICS = /[\u064B-\u065F]/g;
const TATWEEL = /\u0640/g;
const SEARCH_PUNCTUATION = /[^\p{L}\p{N}]+/gu;

export function normalizeArabicForSearch(input: string): string {
  return applySearchAliases(
    input
      .normalize("NFKC")
      .replace(ARABIC_DIACRITICS, "")
      .replace(TATWEEL, "")
      .replace(/[إأآٱ]/g, "ا")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      .replace(/ى/g, "ي")
      .replace(/ة/g, "ه")
      .replace(SEARCH_PUNCTUATION, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}
