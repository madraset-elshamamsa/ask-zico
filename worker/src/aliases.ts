type SearchAlias = {
  canonical: string;
  variants: string[];
};

const SAINT_TITLES = ["القديس", "القديسه", "الانبا", "البابا", "مار"];

const SEARCH_ALIASES: SearchAlias[] = [
  {
    canonical: "القديس جورجيوس",
    variants: ["مار جرجس", "مارجرجس"],
  },
  ...contextualAliases("استشهاد", ["شهاده"], ["القديس", "القديسه"]),
  ...contextualAliases("نياحه", ["موت", "انتقال"], SAINT_TITLES),
  {
    canonical: "ملكي صادق",
    variants: ["ملشي صادق", "ملشيصادق", "ملكيصادق"],
  },
  {
    canonical: "اومونوجينيس",
    variants: ["اومونوجينس"],
  },
];

function contextualAliases(
  canonicalEvent: string,
  eventVariants: string[],
  titles: string[],
): SearchAlias[] {
  return titles.map((title) => ({
    canonical: `${canonicalEvent} ${title}`,
    variants: eventVariants.map((variant) => `${variant} ${title}`),
  }));
}

export function applySearchAliases(input: string): string {
  let value = input;

  for (const alias of SEARCH_ALIASES) {
    for (const variant of alias.variants) {
      value = replaceWholeSearchPhrase(value, variant, alias.canonical);
    }
  }

  return value;
}

function replaceWholeSearchPhrase(input: string, phrase: string, replacement: string): string {
  const escaped = phrase
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join("\\s+");
  return input.replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "gu"), `$1${replacement}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
