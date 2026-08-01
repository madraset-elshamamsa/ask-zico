#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const DEFAULTS = {
  library: "sample",
  metadata: path.join(repoRoot, "examples", "sample-corpus", "metadata.json"),
  mdxDir: path.join(repoRoot, "examples", "sample-corpus", "articles"),
  htmlDir: "",
  annotationsDir: "",
  outDir: path.join(repoRoot, ".local", "assistant-ingest"),
  maxChars: 7000,
  minChars: 60,
};
const CONTENT_TYPE_BY_LIBRARY = {
  wa3zat: "article",
  taqs: "article",
  lessons: "lesson",
  al7an: "hymn",
  ta2amolat: "article",
  aqwal: "quote",
  coptic: "lesson",
  about: "page",
  cartoon: "cartoon",
  seneksar: "seneksar",
  "bible-summary": "bible_summary",
  ma3lomat: "article",
  verse: "verse",
  tari5: "article",
};

const AR = {
  bibleLesson: "\u062f\u0631\u0633 \u0643\u062a\u0627\u0628",
  church: "\u0643\u0646\u0633\u064a\u0627\u062a",
  doctrine: "\u0639\u0642\u064a\u062f\u0629",
  historyInfo: "\u0645\u0639\u0644\u0648\u0645\u0629 \u062a\u0627\u0631\u064a\u062e\u064a\u0629",
  churchInfo: "\u0645\u0639\u0644\u0648\u0645\u0629 \u0643\u0646\u0633\u064a\u0629",
  bibleInfo: "\u0645\u0639\u0644\u0648\u0645\u0629 \u0643\u062a\u0627\u0628\u064a\u0629",
  saints: "\u0642\u062f\u064a\u0633\u064a\u0646",
};

function normalizeMetadataValue(value) {
  return String(value ?? "").trim().toLowerCase();
}

function hasCategory(record, expected) {
  return categoryToArray(record.Category).some(
    (category) => normalizeMetadataValue(category) === normalizeMetadataValue(expected),
  );
}

function semanticDomainForRecord(record, sourceLibrary) {
  if (sourceLibrary === "bible-summary" || sourceLibrary === "verse" || sourceLibrary === "cartoon") {
    return "bible";
  }
  if (sourceLibrary === "al7an" || sourceLibrary === "ta2amolat") {
    return "al7an";
  }
  if (sourceLibrary === "taqs") {
    return "taqs";
  }
  if (sourceLibrary === "coptic") {
    return "coptic";
  }
  if (sourceLibrary === "seneksar") {
    return "saints";
  }
  if (sourceLibrary === "tari5") {
    return hasCategory(record, AR.saints) ? "saints" : "tari5";
  }
  if (sourceLibrary === "ma3lomat") {
    if (hasCategory(record, AR.bibleInfo)) return "bible";
    if (hasCategory(record, AR.historyInfo)) return "tari5";
    return "ta3lim";
  }
  if (sourceLibrary === "kotob" || sourceLibrary === "quotes" || sourceLibrary === "aqwal") {
    return "ta3lim";
  }
  if (sourceLibrary === "wa3zat") {
    if (hasCategory(record, AR.bibleLesson)) return "bible";
    if (hasCategory(record, AR.church)) return "taqs";
    if (hasCategory(record, AR.doctrine)) return "tari5";
    return "ta3lim";
  }
  if (sourceLibrary === "school" || sourceLibrary === "about") {
    return "school";
  }
  return "ta3lim";
}

function facetsForRecord(record, sourceLibrary, semanticDomain) {
  const facets = new Set([semanticDomain]);
  if (sourceLibrary === "wa3zat") facets.add("sermon");
  if (sourceLibrary === "al7an") facets.add("hymn");
  if (sourceLibrary === "ta2amolat") facets.add("hymn");
  if (sourceLibrary === "taqs") facets.add("ritual");
  if (sourceLibrary === "tari5") facets.add("history");
  if (sourceLibrary === "ma3lomat") facets.add("ma3lomat");
  if (sourceLibrary === "seneksar" || semanticDomain === "saints") facets.add("saints");
  if (sourceLibrary === "coptic") facets.add("coptic");
  if (sourceLibrary === "verse") facets.add("verse");
  if (sourceLibrary === "cartoon") facets.add("cartoon");
  if (sourceLibrary === "kotob") facets.add("book");
  if (sourceLibrary === "quotes" || sourceLibrary === "aqwal") facets.add("fathers");
  if (sourceLibrary === "about") facets.add("school");
  if (hasCategory(record, AR.doctrine)) facets.add("doctrine");
  if (hasCategory(record, AR.church)) facets.add("ritual");
  if (hasCategory(record, AR.churchInfo)) facets.add("church");
  if (hasCategory(record, AR.historyInfo)) facets.add("history");
  if (hasCategory(record, AR.bibleLesson) || hasCategory(record, AR.bibleInfo)) {
    facets.add("bible");
  }
  return [...facets].sort();
}

// Extensions accepted when walking an HTML source directory.
const HTML_SOURCE_EXTENSIONS = new Set([".txt", ".html", ".htm", ".md"]);

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  const provided = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    if (key === "maxChars" || key === "minChars") {
      args[key] = Number(next);
      if (!Number.isFinite(args[key]) || args[key] <= 0) {
        throw new Error(`--${key} must be a positive number`);
      }
    } else {
      args[key] = next;
    }
    provided.add(key);
    i += 1;
  }

  return args;
}

function applyLibraryDefaults(args, provided) {
  const defaults = LIBRARY_DEFAULTS[args.library];
  if (!defaults) return;

  for (const [key, value] of Object.entries(defaults)) {
    if (!provided.has(key)) {
      args[key] = value;
    }
  }
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function slugFromUrl(url) {
  const parsed = new URL(url);
  if (path.basename(parsed.pathname) === "generateVerse.php") {
    const id = parsed.searchParams.get("id");
    if (id && /^\d+$/.test(id)) return "verse-" + id;
  }
  if (path.basename(parsed.pathname).toLowerCase() === "seneksar.php") {
    const id = parsed.searchParams.get("q");
    if (id && /^[0-9]+$/.test(id)) return "day-" + id;
  }
  return path.basename(parsed.pathname, ".php");
}

// ─── MDX parsing ─────────────────────────────────────────────────────────────

function parseFrontmatter(source) {
  if (!source.startsWith("---")) {
    return { data: {}, body: source };
  }
  const end = source.indexOf("\n---", 3);
  if (end === -1) {
    return { data: {}, body: source };
  }
  const raw = source.slice(3, end).trim();
  const body = source.slice(end + 4);
  const data = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (value.trim()) {
      data[key] = unquoteYamlValue(value.trim());
      continue;
    }

    const list = [];
    while (i + 1 < lines.length) {
      const itemMatch = lines[i + 1].match(/^\s+-\s*(.*)$/);
      if (!itemMatch) break;
      list.push(unquoteYamlValue(itemMatch[1].trim()));
      i += 1;
    }
    data[key] = list.length ? list : "";
  }
  return { data, body };
}

function unquoteYamlValue(value) {
  return value.replace(/^["']|["']$/g, "");
}

// Text cleaning

function stripHtmlTags(input) {
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanHeading(raw) {
  return normalizeWhitespace(
    stripHtmlTags(
      raw
        .replace(/^#{1,6}\s*/, "")
        .replace(/\*\*/g, "")
        .replace(/`/g, ""),
    ),
  );
}

function mdxToPlainText(input) {
  let text = input;
  text = text.replace(/\r\n/g, "\n");
  text = text.replace(/^import\s+.*$/gm, "");
  text = text.replace(/^export\s+.*$/gm, "");
  text = text.replace(
    /<FancyQuote[^>]*\bfooter=["']([^"']*)["'][^>]*>/gi,
    (_, footer) => `\n${footer}\n`,
  );
  text = text.replace(/<\/?FancyQuote[^>]*>/gi, "\n");
  text = text.replace(/<\/?[A-Z][A-Za-z0-9_.:-]*(?:\s[^>]*)?>/g, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = stripHtmlTags(text);
  text = text.replace(/!\[[^\]]*]\([^)]*\)/g, "");
  text = text.replace(/\[([^\]]+)]\([^)]*\)/g, "$1");
  text = text.replace(/^\s{0,4}[-*+]\s+/gm, "");
  text = text.replace(/^\s{0,4}\d+[.)]\s+/gm, "");
  text = text.replace(/[*_]{1,3}/g, "");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^---+\s*$/gm, "\n");
  // Heading markers (# through #####) are intentionally preserved so that
  // splitLongText can use them as semantic split points at every heading level.
  return normalizeWhitespace(text);
}

/**
 * Converts HTML to plain text while replacing <h1>–<h5> tags with their
 * markdown equivalents (#–#####). This lets the unified heading-level cascade
 * in splitLongText work identically for both MDX and HTML sources.
 */
function htmlToPlainText(input) {
  let html = input.replace(/\r\n/g, "\n");
  // Convert heading tags to markdown markers before stripping remaining tags.
  for (let level = 1; level <= 5; level++) {
    const hashes = "#".repeat(level);
    html = html.replace(
      new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi"),
      (_, inner) => `\n${hashes} ${stripHtmlTags(inner).trim()}\n`,
    );
  }
  return normalizeWhitespace(stripHtmlTags(html));
}

function normalizeWhitespace(input) {
  return input
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Normalizes Arabic text for search/embedding only.
// Non-Arabic scripts (Coptic) are intentionally
// stripped by the \p{L}\p{N}\s guard — the Arabic portions are normalized
// and the non-Arabic portions become whitespace. This is acceptable for
// search_text; the original Arabic and Coptic are preserved in `text`.
function normalizeArabicForSearch(input) {
  return input
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ـ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ─── Source discovery ─────────────────────────────────────────────────────────

function findMdxSource(mdxDir, slug) {
  const candidates = [
    `${slug}.mdx`,
    `${slug}.md`,
    `${slug[0]?.toLowerCase()}${slug.slice(1)}.mdx`,
    `${slug[0]?.toLowerCase()}${slug.slice(1)}.md`,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const filePath = path.join(mdxDir, candidate);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

/**
 * Walk the slug directory under htmlDir and return the first file whose
 * extension is in HTML_SOURCE_EXTENSIONS, trying both the original slug
 * casing and a lowercase-first variant.
 */
function findHtmlSource(htmlDir, slug) {
  const slugVariants = [
    slug,
    `${slug[0]?.toLowerCase()}${slug.slice(1)}`,
  ].filter(Boolean);

  for (const variant of slugVariants) {
    const dir = path.join(htmlDir, variant);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (
        entry.isFile() &&
        HTML_SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        return path.join(dir, entry.name);
      }
    }
  }
  return null;
}

/**
 * Load the full article text as a single unit. Splitting into chunks happens
 * later in splitLongText, driven by actual length rather than by structure.
 */
function loadSource(args, slug) {
  const mdxPath = findMdxSource(args.mdxDir, slug);
  if (mdxPath) {
    const { data, body } = parseFrontmatter(readText(mdxPath));
    return {
      sourceKind: "mdx",
      sourceRef: path.basename(mdxPath),
      fullText: mdxToPlainText(body),
      frontmatter: data,
    };
  }

  const htmlPath = findHtmlSource(args.htmlDir, slug);
  if (htmlPath) {
    return {
      sourceKind: "html",
      sourceRef: path.relative(args.htmlDir, htmlPath),
      fullText: htmlToPlainText(readText(htmlPath)),
    };
  }

  return null;
}

// ─── Chunk splitting ──────────────────────────────────────────────────────────

/**
 * Splits `text` on lines that begin with exactly `level` hash signs followed
 * by a space (e.g. level=2 matches "## Heading" but not "### Sub").
 *
 * Returns the original single-element array when no headings at this level
 * are found, so the caller can detect a no-op and try the next level.
 */
function splitOnHeadingLevel(text, level) {
  const hashes = "#".repeat(level);
  // Anchor to start-of-line; the negative lookahead (?!#) ensures we match
  // exactly `level` hashes and not a deeper heading.
  const pattern = new RegExp(`^${hashes}(?!#)\\s+`, "m");
  if (!pattern.test(text)) return [text]; // no headings at this level

  const linePattern = new RegExp(`^${hashes}(?!#)\\s+`);
  const lines = text.split("\n");
  const chunks = [];
  let current = [];

  for (const line of lines) {
    if (linePattern.test(line) && current.length > 0) {
      const chunk = current.join("\n").trim();
      if (chunk) chunks.push(chunk);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) {
    const chunk = current.join("\n").trim();
    if (chunk) chunks.push(chunk);
  }

  return chunks.length > 1 ? chunks : [text];
}

/**
 * Main public entry point. Tries to keep the article whole; splits only when
 * necessary, cascading from coarsest to finest boundary:
 *
 *   Whole article → h1 → h2 → h3 → h4 → h5 → paragraphs → sentences
 *
 * Each level is tried only on chunks that still exceed maxChars, so the
 * splitting is as coarse as the content allows.
 */
function splitLongText(text, maxChars) {
  return splitFromLevel(text, maxChars, 1);
}

/**
 * Recursive helper. Attempts splitting at `level` first; if the text has no
 * headings at that level, advances to the next level without producing any
 * sub-chunks. Falls through to paragraph/sentence splitting after h5.
 */
function splitFromLevel(text, maxChars, level) {
  if (text.length <= maxChars) return [text];

  if (level <= 5) {
    const blocks = splitOnHeadingLevel(text, level);
    if (blocks.length > 1) {
      return packSemanticBlocks(blocks, maxChars, level);
    }
    // No headings at this level — try the next one.
    return splitFromLevel(text, maxChars, level + 1);
  }

  // All heading levels exhausted — fall back to paragraphs then sentences.
  return splitByParagraphs(text, maxChars);
}

function packSemanticBlocks(blocks, maxChars, level) {
  const chunks = [];
  let current = "";

  for (const block of blocks) {
    const parts =
      block.length <= maxChars ? [block] : splitFromLevel(block, maxChars, level + 1);

    for (const part of parts) {
      const candidate = current ? `${current}\n\n${part}` : part;
      if (candidate.length <= maxChars) {
        current = candidate;
        continue;
      }

      if (current) chunks.push(current);
      current = part;
    }
  }

  if (current) chunks.push(current);
  return chunks.length ? chunks : blocks;
}

/** Stage 2 + 3: paragraph then sentence splitting. */
function splitByParagraphs(text, maxChars) {
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) continue;
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;

    if (candidate.trim().length <= maxChars) {
      current = candidate.trim();
      continue;
    }

    if (current) chunks.push(current);

    if (paragraph.length <= maxChars) {
      current = paragraph;
    } else {
      // Stage 3: sentence splitting
      const sentences = paragraph.split(/(?<=[.!؟])\s+/u);
      current = "";
      for (const sentence of sentences) {
        const sc = current ? `${current} ${sentence}` : sentence;
        if (sc.trim().length <= maxChars) {
          current = sc.trim();
        } else {
          if (current) chunks.push(current);
          current = sentence;
        }
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text];
}

// ─── Chunk assembly ───────────────────────────────────────────────────────────

function categoryToArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return [String(value)];
}

function authorsToArray(value) {
  return categoryToArray(value).flatMap((entry) => {
    if (typeof entry !== "string") return [String(entry)];
    try {
      const parsed = JSON.parse(entry);
      if (Array.isArray(parsed?.author)) {
        return parsed.author.map((author) => String(author).trim()).filter(Boolean);
      }
    } catch {
      // Most libraries already store plain author strings.
    }
    return [entry];
  });
}

function metadataSummaryText(record) {
  const value = record.Summary;
  if (!value) return "";
  if (typeof value !== "string") return String(value);
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return [parsed.She3ar, parsed.Mola5as].filter(Boolean).join("\n");
    }
  } catch {
    // Plain-text summaries are the normal Wa3zat shape.
  }
  return value;
}

function sourceKeywords(source) {
  return categoryToArray(source.frontmatter?.keywords);
}

function chunkKeywords(record, source) {
  return [...new Set([...categoryToArray(record.Keywords), ...sourceKeywords(source)].filter(Boolean))];
}

function metadataSearchText(record, slug, source) {
  return [
    record.Title || slug,
    record.Library,
    ...categoryToArray(record.Category),
    ...authorsToArray(record.Authors),
    metadataSummaryText(record),
    ...chunkKeywords(record, source),
  ]
    .filter(Boolean)
    .join("\n");
}

const ARABIC_ENRICHMENT_STOPWORDS = new Set(
  [
    "في",
    "من",
    "عن",
    "على",
    "الى",
    "إلى",
    "مع",
    "ده",
    "دي",
    "دا",
    "كان",
    "كانت",
    "فيه",
    "ربنا",
    "الله",
    "الرب",
    "السيد",
    "المسيح",
    "الكتاب",
    "المقدس",
    "اللي",
    "الذي",
    "التي",
    "هذا",
    "هذه",
    "بعد",
    "قبل",
    "كل",
    "لكن",
    "عشان",
    "انه",
    "إنه",
    "لما",
    "لمّا",
  ].map((term) => normalizeArabicForSearch(term)),
);

const ENRICHMENT_LIMITS = {
  entities: 24,
  events: 24,
  places: 16,
  aliases: 24,
  symbols: 8,
  themes: 8,
  enriched_terms: 40,
  detail_search_text_chars: 1000,
};

const LOW_VALUE_ENRICHMENT_PATTERNS = [
  /^اصحاح$/,
  /^صلاه$/,
  /^قال$/,
  /^سنه$/,
  /^جدا$/,
  /^عن السفر$/,
  /^ترتيب السفر$/,
  /^شعار السفر$/,
  /^ملخص سريع$/,
  /^ملخص السفر/,
  /^تفسير وتاملات$/,
  /^ايات وتاملات$/,
  /^نتعلم ايه$/,
  /(^|\s)اصحاحات?($|\s)/,
  /(^|\s)ملخص($|\s)/,
  /(^|\s)سريع($|\s)/,
  /^\d+\s+/,
];

const AUTO_ENTITY_CONCEPT_TOKENS = new Set(
  [
    "هدف",
    "اهداف",
    "ظروف",
    "مفاتيح",
    "فهم",
    "السفر",
    "مقدمه",
    "مقدمه",
    "مدخل",
    "ملخص",
    "فكره",
    "فكرة",
    "اساسيه",
    "اساسية",
    "شعار",
    "ترتيب",
    "تقسيم",
    "اقسام",
    "موضوع",
    "محور",
    "البركه",
    "البركة",
    "الشعب",
    "الارض",
    "الأرض",
    "السلام",
    "الخطيه",
    "الخطية",
    "التوبه",
    "التوبة",
    "الانقاذ",
    "الإنقاذ",
    "الذل",
    "الوعد",
    "وعد",
    "تغيير",
    "كرم",
    "تواضع",
    "عدل",
    "رحمه",
    "رحمة",
    "الله",
    "الختان",
  ].map((term) => normalizeArabicForSearch(term)),
);

const AUTO_ENTITY_CONCEPT_PHRASES = [
  "هدف السفر",
  "ظروف الكتابه",
  "ظروف الكتابة",
  "مفاتيح فهم السفر",
  "فكره السفر",
  "فكرة السفر",
  "مقدمه السفر",
  "مقدمة السفر",
  "ترتيب السفر",
  "تقسيم السفر",
].map((term) => normalizeArabicForSearch(term));

function enrichBibleDomainChunk(part, section, annotations) {
  const tableEntities = extractTableEntityPhrases(part);
  const colonEntities = extractColonEntityPhrases(part);
  const entities = limitCoreTerms(
    [...annotations.entities, ...tableEntities, ...colonEntities].filter(isEntityLikePhrase),
    ENRICHMENT_LIMITS.entities,
  );
  const events = limitCoreTerms(annotations.events, ENRICHMENT_LIMITS.events);
  const places = limitCoreTerms(annotations.places, ENRICHMENT_LIMITS.places);
  const symbols = limitCoreTerms(annotations.symbols, ENRICHMENT_LIMITS.symbols);
  const themes = limitCoreTerms(annotations.themes, ENRICHMENT_LIMITS.themes);
  const enrichedTerms = limitCoreTerms(
    withoutExistingTerms(
      annotations.enriched_terms,
      [...entities, ...events, ...places, ...symbols, ...themes],
    ),
    ENRICHMENT_LIMITS.enriched_terms,
  );
  const aliases = limitCoreTerms(
    [...annotations.aliases, ...entityNameAliases(entities)],
    ENRICHMENT_LIMITS.aliases,
  );

  return {
    entities,
    events,
    places,
    symbols,
    themes,
    aliases,
    enriched_terms: enrichedTerms,
  };
}

function entityNameAliases(entities) {
  const aliases = [];
  for (const entity of entities) {
    const normalized = normalizeArabicForSearch(entity);
    const tokens = normalized.split(/\s+/).filter(Boolean);
    if (tokens.length < 2 || tokens.length > 5) continue;

    const [firstToken] = tokens;
    if (isUsefulEntityAliasToken(firstToken)) {
      aliases.push(firstToken);
    }
    aliases.push(tokens.join(""));
  }
  return aliases;
}

function isUsefulEntityAliasToken(token) {
  return (
    token.length >= 3 &&
    !["ابن", "بن", "بنت", "من", "الى", "الي", "ال", "ملكي"].includes(token) &&
    !ARABIC_ENRICHMENT_STOPWORDS.has(token)
  );
}

function bibleDetailSearchText(part, annotations) {
  const annotationText = [
    ...annotations.entities,
    ...annotations.events,
    ...annotations.places,
    ...annotations.aliases,
  ];
  return normalizeArabicForSearch([...new Set(annotationText)].join("\n")).slice(
    0,
    ENRICHMENT_LIMITS.detail_search_text_chars,
  );
}

function extractTableEntityPhrases(text) {
  const values = [];
  let entityColumnIndexes = null;
  for (const line of text.split("\n")) {
    if (!isMarkdownTableRow(line)) continue;
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .filter((cell) => !/^-+$/.test(cell.replace(/\s+/g, "")));
    if (!cells.length) continue;
    const headerIndexes = tableEntityColumnIndexes(cells);
    if (headerIndexes.length) {
      entityColumnIndexes = headerIndexes;
      continue;
    }
    const candidateCells = entityColumnIndexes
      ? entityColumnIndexes.map((index) => cells[index]).filter(Boolean)
      : cells;
    for (const cell of candidateCells) {
      values.push(...entityPhrasesFromCell(cell));
    }
  }
  return values;
}

function tableEntityColumnIndexes(cells) {
  const entityHeaders = new Set([
    "الاسم",
    "القاضي",
    "النبي",
    "النبيه",
    "النبيّة",
    "الرسول",
    "الرسل",
    "التلميذ",
    "التلاميذ",
    "الملك",
    "الملكه",
    "الملكة",
    "الشخص",
    "الشخصيه",
    "الشخصية",
  ]);
  return cells
    .map((cell, index) => ({ cell: normalizeArabicForSearch(cell), index }))
    .filter(({ cell }) => entityHeaders.has(cell))
    .map(({ index }) => index);
}

function extractColonEntityPhrases(text) {
  const values = [];
  for (const line of text.split("\n")) {
    if (!isColonEntityLine(line)) continue;
    const [name] = line.split(/\s*[:：]\s*/);
    values.push(...entityPhrasesFromCell(name));
  }
  return values;
}

function isMarkdownTableRow(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.includes("|");
}

function isColonEntityLine(line) {
  const trimmed = line.trim();
  const colonIndex = Math.max(trimmed.indexOf(":"), trimmed.indexOf("："));
  if (colonIndex <= 0 || colonIndex > 80) return false;
  const name = trimmed.slice(0, colonIndex).trim();
  if (!/^[\p{Script=Arabic}\s]+$/u.test(name)) return false;
  return isEntityCell(name);
}

function entityPhrasesFromCell(cell) {
  return cell
    .split(/\s+\u0648\s+|\s*،\s*/u)
    .map((part) =>
      part
        .replace(
          /^(?:\u0642\u0627\u0626\u062f|\u0642\u0627\u064a\u062f)\s+(?:\u0627\u0644\u062c\u064a\u0634|جيش)\s+/u,
          "",
        )
        .replace(/^(?:\u0627\u0644\u0645\u0644\u0643|\u0645\u0644\u0643)\s+/u, "")
        .trim(),
    )
    .filter(isEntityCell);
}

function isEntityCell(value) {
  const normalized = normalizeArabicForSearch(value);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 5) return false;
  if (!/[\u0621-\u064A]/.test(normalized)) return false;
  if (/\d/.test(normalized)) return false;
  if (LOW_VALUE_ENRICHMENT_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  if (isAutoEntityConceptHeading(normalized, tokens)) return false;
  return tokens.some(
    (token) => token.length >= 3 && !ARABIC_ENRICHMENT_STOPWORDS.has(token),
  );
}

function isAutoEntityConceptHeading(normalized, tokens) {
  if (AUTO_ENTITY_CONCEPT_PHRASES.includes(normalized)) return true;
  if (tokens.length === 1 && AUTO_ENTITY_CONCEPT_TOKENS.has(tokens[0])) return true;
  if (tokens.length > 1 && AUTO_ENTITY_CONCEPT_TOKENS.has(tokens[0])) return true;
  if (tokens.length <= 3 && tokens.every((token) => AUTO_ENTITY_CONCEPT_TOKENS.has(token))) {
    return true;
  }
  return false;
}

function extractHeadingPhrases(text) {
  return text
    .split("\n")
    .filter((line) => /^#{1,5}\s+/.test(line))
    .map(cleanHeading)
    .filter((heading) => heading.length >= 3 && heading.length <= 80);
}

function isCoreEnrichmentPhrase(phrase) {
  const normalized = normalizeArabicForSearch(phrase);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return (
    tokens.length > 0 &&
    tokens.length <= 4 &&
    !normalized.includes("اصحاح") &&
    !normalized.includes("ملخص") &&
    !LOW_VALUE_ENRICHMENT_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

function isEntityLikePhrase(phrase) {
  const tokens = phrase.split(/\s+/);
  return (
    tokens.length <= 3 &&
    tokens.some((token) => token.length >= 3)
  );
}

function limitCoreTerms(values, limit) {
  return [...new Set(values.filter(isCoreEnrichmentPhrase))].slice(0, limit);
}

function withoutExistingTerms(values, existingValues) {
  const existing = new Set(existingValues.map(normalizeArabicForSearch));
  return values.filter((value) => !existing.has(normalizeArabicForSearch(value)));
}

const ANNOTATION_FIELDS = [
  "entities",
  "events",
  "places",
  "aliases",
  "symbols",
  "themes",
  "enriched_terms",
];

function emptyAnnotations() {
  return Object.fromEntries(ANNOTATION_FIELDS.map((field) => [field, []]));
}

function loadAnnotations(args, slug) {
  if (!args.annotationsDir) return {};
  const candidates = [
    path.join(args.annotationsDir, `${slug}.rag.json`),
    path.join(args.annotationsDir, `${slug}.annotations.json`),
  ];
  const filePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!filePath) return {};
  return JSON.parse(readText(filePath));
}

function annotationsForChunk(annotationFile, section, chunkIndex) {
  const merged = emptyAnnotations();
  const chunkKey = String(chunkIndex);
  mergeAnnotationFields(merged, annotationFile);
  mergeAnnotationFields(merged, annotationFile.sections?.[section]);
  mergeAnnotationFields(merged, annotationFile.sections?.[chunkKey]);
  mergeAnnotationFields(merged, annotationFile.chunks?.[chunkKey]);
  return Object.fromEntries(
    ANNOTATION_FIELDS.map((field) => [
      field,
      [...new Set(merged[field].map((value) => String(value).trim()).filter(Boolean))],
    ]),
  );
}

function mergeAnnotationFields(target, source) {
  if (!source || typeof source !== "object") return;
  for (const field of ANNOTATION_FIELDS) {
    const values = Array.isArray(source[field]) ? source[field] : [];
    target[field].push(...values);
  }
}

/**
 * Returns the cleaned text of the first heading marker found in the chunk,
 * or the fallback label when the chunk starts with body text.
 */
function extractChunkHeading(text) {
  const firstLine = text.split("\n")[0].trim();
  if (/^#{1,5}\s+/.test(firstLine)) {
    return cleanHeading(firstLine);
  }
  return "المحتوى";
}

function buildChunks(record, source, args) {
  const slug = slugFromUrl(record.URL);
  const chunks = [];
  const keywords = chunkKeywords(record, source);
  const metadataText = metadataSearchText(record, slug, source);
  const semanticDomain = semanticDomainForRecord(record, args.library);
  const facets = facetsForRecord(record, args.library, semanticDomain);
  const annotationFile = loadAnnotations(args, slug);

  const parts = splitLongText(source.fullText, args.maxChars);
  let chunkIndex = 0;

  for (const part of parts) {
    if (part.length < args.minChars) continue;
    const chunkId = `${args.library}:${slug}:${chunkIndex}`;
    const section = extractChunkHeading(part);
    const annotations = annotationsForChunk(annotationFile, section, chunkIndex);
    const hasAnnotations = ANNOTATION_FIELDS.some((field) => annotations[field].length > 0);
    const shouldEnrich = semanticDomain === "bible" || hasAnnotations;
    const bibleEnrichment = shouldEnrich ? enrichBibleDomainChunk(part, section, annotations) : {};
    chunks.push({
      doc_id: `${args.library}:${slug}`,
      chunk_id: chunkId,
      url: record.URL,
      title: record.Title || slug,
      library: record.Library || "وعظات",
      source_library: args.library,
      content_type: CONTENT_TYPE_BY_LIBRARY[args.library] || "article",
      section,
      language: "ar",
      source_kind: source.sourceKind,
      source_ref: source.sourceRef,
      categories: categoryToArray(record.Category),
      authors: authorsToArray(record.Authors),
      summary: record.Summary || "",
      keywords,
      semanticDomain,
      facets,
      ...bibleEnrichment,
      ...(shouldEnrich
        ? { detail_search_text: bibleDetailSearchText(part, annotations) }
        : {}),
      // `text` is the original Arabic (with tashkeel, Coptic preserved).
      // It is never altered — this is what the LLM reads and citations show.
      text: part,
      // `search_text` is the normalized form used for embedding and lexical
      // search. It includes metadata so users can ask by author, occasion,
      // category, and tags without polluting the text shown to the LLM.
      search_text: normalizeArabicForSearch(
        `${metadataText}\n${part}\n${Object.values(bibleEnrichment).flat().join("\n")}`,
      ),
    });
    chunkIndex += 1;
  }
  return chunks;
}

// ─── Output ───────────────────────────────────────────────────────────────────

function writeJsonl(filePath, rows) {
  fs.writeFileSync(
    filePath,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
}

function writeJson(filePath, rows) {
  fs.writeFileSync(filePath, JSON.stringify(rows, null, 2) + "\n", "utf8");
}

function safeFileName(input) {
  return input.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function ensureGeneratedChildDir(parentDir, childDir) {
  const parent = path.resolve(parentDir);
  const child = path.resolve(childDir);
  if (child !== parent && !child.startsWith(`${parent}${path.sep}`)) {
    throw new Error(`Refusing to write outside output directory: ${child}`);
  }
  fs.rmSync(child, { recursive: true, force: true });
  ensureDir(child);
}

function writeChunkJsonDirectory(dirPath, chunks) {
  const cloudflareJsonRoot = path.dirname(dirPath);
  ensureGeneratedChildDir(path.dirname(cloudflareJsonRoot), dirPath);

  const files = [];
  for (const chunk of chunks) {
    const fileName = `${safeFileName(chunk.chunk_id.replace(/:/g, "-"))}.json`;
    const filePath = path.join(dirPath, fileName);
    fs.writeFileSync(filePath, JSON.stringify(chunk, null, 2) + "\n", "utf8");
    files.push(fileName);
  }

  fs.writeFileSync(
    path.join(cloudflareJsonRoot, `${path.basename(dirPath)}-manifest.json`),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        chunk_count: chunks.length,
        files,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

function writeCloudflareSearchDocs(dirPath, chunks) {
  const cloudflareDocsRoot = path.dirname(dirPath);
  ensureGeneratedChildDir(path.dirname(cloudflareDocsRoot), dirPath);

  const files = [];
  for (const chunk of chunks) {
    const fileName = `${safeFileName(chunk.chunk_id.replace(/:/g, "-"))}.md`;
    const filePath = path.join(dirPath, fileName);
    const body = [
      `chunk_id: ${chunk.chunk_id}`,
      `doc_id: ${chunk.doc_id}`,
      `title: ${chunk.title}`,
      `url: ${chunk.url}`,
      `content_type: ${chunk.content_type}`,
      `library: ${chunk.library}`,
      `section: ${chunk.section}`,
      `source_ref: ${chunk.source_ref}`,
      "",
      "search_text:",
      chunk.search_text,
      "",
    ].join("\n");
    fs.writeFileSync(filePath, body, "utf8");
    files.push(fileName);
  }

  fs.writeFileSync(
    path.join(cloudflareDocsRoot, `${path.basename(dirPath)}-manifest.json`),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        chunk_count: chunks.length,
        files,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

function writeChunkLookup(filePath, chunks) {
  ensureDir(path.dirname(filePath));
  const lookup = {};
  for (const chunk of chunks) {
    lookup[chunk.chunk_id] = chunk;
  }
  fs.writeFileSync(filePath, JSON.stringify(lookup, null, 2) + "\n", "utf8");
}

function writeReport(filePath, report) {
  const lines = [];
  lines.push(`# Assistant Ingestion Report: ${report.library}`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`- Metadata records: ${report.records}`);
  lines.push(`- Matched documents: ${report.matched}`);
  lines.push(`- Missing source documents: ${report.missing.length}`);
  lines.push(`- Chunks emitted: ${report.chunks}`);
  lines.push(
    `- Source kinds: ${Object.entries(report.sourceKinds)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
  );
  lines.push("");
  if (report.missing.length) {
    lines.push("## Missing Sources");
    lines.push("");
    for (const item of report.missing) {
      lines.push(`- ${item.slug}: ${item.url}`);
    }
    lines.push("");
  }
  lines.push("## Sample Chunks");
  lines.push("");
  for (const chunk of report.samples) {
    lines.push(`### ${chunk.title} / ${chunk.section}`);
    lines.push("");
    lines.push(`- URL: ${chunk.url}`);
    lines.push(`- Chunk: ${chunk.chunk_id}`);
    lines.push(`- Source: ${chunk.source_kind}`);
    lines.push("");
    lines.push("```text");
    lines.push(chunk.text.slice(0, 700));
    lines.push("```");
    lines.push("");
    lines.push("```search_text");
    lines.push(chunk.search_text.slice(0, 350));
    lines.push("```");
    lines.push("");
  }
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureDir(args.outDir);

  const metadata = JSON.parse(readText(args.metadata));
  const chunks = [];
  const missing = [];
  const sourceKinds = {};

  // The start is always the JSON export for Algolia
  for (const record of metadata) {
    const slug = slugFromUrl(record.URL);
    const source = loadSource(args, slug);
    if (!source) {
      missing.push({ slug, url: record.URL });
      continue;
    }
    sourceKinds[source.sourceKind] = (sourceKinds[source.sourceKind] || 0) + 1;
    chunks.push(...buildChunks(record, source, args));
  }

  const jsonlPath = path.join(args.outDir, `${args.library}.jsonl`);
  const jsonPath = path.join(args.outDir, `${args.library}.json`);
  const chunkJsonDir = path.join(args.outDir, "cloudflare-json", args.library);
  const searchDocsDir = path.join(
    args.outDir,
    "cloudflare-search-docs",
    args.library,
  );
  const chunkLookupPath = path.join(args.outDir, "chunk-lookup", `${args.library}.json`);
  const reportPath = path.join(args.outDir, `${args.library}-report.md`);
  writeJsonl(jsonlPath, chunks);
  writeJson(jsonPath, chunks);
  writeChunkJsonDirectory(chunkJsonDir, chunks);
  writeCloudflareSearchDocs(searchDocsDir, chunks);
  writeChunkLookup(chunkLookupPath, chunks);
  writeReport(reportPath, {
    library: args.library,
    records: metadata.length,
    matched: metadata.length - missing.length,
    missing,
    chunks: chunks.length,
    sourceKinds,
    samples: chunks.slice(0, 8),
  });

  console.log(`Wrote ${chunks.length} chunks to ${jsonlPath}`);
  console.log(`Wrote ${chunks.length} chunks to ${jsonPath}`);
  console.log(`Wrote ${chunks.length} chunk JSON files to ${chunkJsonDir}`);
  console.log(`Wrote ${chunks.length} AI Search markdown files to ${searchDocsDir}`);
  console.log(`Wrote chunk lookup to ${chunkLookupPath}`);
  console.log(`Wrote report to ${reportPath}`);
  if (missing.length) {
    console.log(`Missing ${missing.length} source documents`);
  }
}

main();
